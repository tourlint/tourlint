import { describe, expect, it } from 'vitest';
import type { KtoClient } from '../external/kto';
import { KtoFetchError } from '../external/kto/kto.errors';
import type { BatchState, BatchStateRepository, BatchStatus, SystemSetting } from '../persistence/batch-state.repository';
import type { NotificationRepository, NotificationToSave } from '../persistence/notification.repository';
import type { ChangedContent, ImpactCandidate } from './impact-finder';
import { SyncBatchJob, toSyncedContent } from './sync-batch.job';

/** 한국 시간 문자열을 Date 로 */
const kst = (iso: string): Date => new Date(`${iso}+09:00`);

/** `areaBasedSyncList2` 응답 항목 하나 — 실제 픽스처의 필드 구성이다 */
const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  contentid: '2541883', contenttypeid: '15', modifiedtime: '20260819131329',
  showflag: '1', createdtime: '20220913132227',
  // 공사 원문. 우리가 담지 않아야 하는 것들이다
  title: '강릉 국가유산야행', addr1: '강원특별자치도 강릉시', firstimage: 'http://x/y.jpg',
  ...over,
});

interface StateSpec {
  readonly lastCovered?: string | null;
  readonly enabled?: boolean;
}

/** 상태 저장소 스텁. 기록된 것을 그대로 들여다볼 수 있게 한다 */
function stubState(spec: StateSpec = {}) {
  const recorded: { status: BatchStatus; itemCount: number; lastCovered?: string }[] = [];
  const repo = {
    find: async (): Promise<BatchState> => ({
      lastCovered: spec.lastCovered === undefined ? '2026-08-25' : spec.lastCovered,
      lastRunAt: null, lastStatus: null, lastItemCount: null,
    }),
    setting: async (): Promise<SystemSetting> => ({
      batchTime: '05:00', batchEnabled: spec.enabled ?? true, dailyQuota: 800,
    }),
    record: async (r: { status: BatchStatus; itemCount: number; lastCovered?: string }): Promise<void> => {
      recorded.push({ status: r.status, itemCount: r.itemCount, lastCovered: r.lastCovered });
    },
  } as unknown as BatchStateRepository;
  return { repo, recorded };
}

/** 날짜별 응답을 정해 주는 공사 스텁 */
function stubKto(byDate: Record<string, Record<string, unknown>[] | Error>) {
  const calls: string[] = [];
  const kto = {
    areaBasedSyncList: async ({ modifiedDate }: { modifiedDate: string }) => {
      calls.push(modifiedDate);
      const found = byDate[modifiedDate] ?? [];
      if (found instanceof Error) throw found;
      return { items: found, pageNo: 1, numOfRows: 1000, totalCount: found.length };
    },
  } as unknown as KtoClient;
  return { kto, calls };
}

const job = (
  kto: KtoClient, state: BatchStateRepository,
  over: {
    now?: string;
    hasBudget?: () => boolean;
    notifications?: NotificationRepository;
    enrich?: (c: readonly { contentId: string }[]) => Promise<readonly ChangedContent[]>;
    requestAudit?: (productId: number) => Promise<void>;
  } = {},
): SyncBatchJob =>
  new SyncBatchJob({
    kto, state,
    clock: () => kst(over.now ?? '2026-08-27T05:00:00'),
    hasBudget: over.hasBudget,
    notifications: over.notifications,
    enrich: over.enrich as never,
    requestAudit: over.requestAudit,
  });

const candidate = (over: Partial<ImpactCandidate> = {}): ImpactCandidate => ({
  productId: 1, startDate: '2026-08-27', nights: 1, ldongSignguCd: '150', ...over,
});

/** 알림 저장소 스텁. 넣은 것을 그대로 들여다볼 수 있게 한다 */
function stubNotifications(spec: {
  withContent?: Record<string, ImpactCandidate[]>;
  watched?: ImpactCandidate[];
} = {}) {
  const saved: NotificationToSave[] = [];
  const lookups: string[] = [];
  const repo = {
    productsWithContent: async (contentId: string): Promise<readonly ImpactCandidate[]> => {
      lookups.push(contentId);
      return spec.withContent?.[contentId] ?? [];
    },
    watchedProducts: async (): Promise<readonly ImpactCandidate[]> => spec.watched ?? [],
    insertMany: async (items: readonly NotificationToSave[]): Promise<number> => {
      saved.push(...items);
      return items.length;
    },
  } as unknown as NotificationRepository;
  return { repo, saved, lookups };
}

describe('실행 조건 (FR-MO-010)', () => {
  it('꺼져 있으면 돌지 않는다', async () => {
    const { repo, recorded } = stubState({ enabled: false });
    const { kto, calls } = stubKto({});
    const result = await job(kto, repo).run();

    expect(result.skippedReason).toBe('DISABLED');
    expect(calls).toHaveLength(0);
    // 건너뛴 것은 실행이 아니다. 상태를 건드리지 않는다
    expect(recorded).toHaveLength(0);
  });

  it('🔴 주말에는 돌지 않는다', async () => {
    const { repo } = stubState();
    const { kto, calls } = stubKto({});
    // 2026-08-29 는 토요일
    const result = await job(kto, repo, { now: '2026-08-29T05:00:00' }).run();

    expect(result.skippedReason).toBe('WEEKEND');
    expect(calls).toHaveLength(0);
  });

  it('처리할 날짜가 없으면 부르지 않는다', async () => {
    const { repo } = stubState({ lastCovered: '2026-08-26' });
    const { kto, calls } = stubKto({});
    expect((await job(kto, repo).run()).skippedReason).toBe('NO_DATES');
    expect(calls).toHaveLength(0);
  });
});

describe('날짜 순회 (FR-MO-011)', () => {
  it('🔴 하루씩 나눠 부른다 — modifiedtime 이 누적되지 않는다', async () => {
    const { repo } = stubState({ lastCovered: '2026-08-23' });
    const { kto, calls } = stubKto({
      '20260824': [item({ contentid: '1' })],
      '20260825': [item({ contentid: '2' })],
      '20260826': [item({ contentid: '3' })],
    });
    const result = await job(kto, repo).run();

    expect(calls).toEqual(['20260824', '20260825', '20260826']);
    expect(result.contents.map((c) => c.contentId)).toEqual(['1', '2', '3']);
    expect(result.covered).toBe('2026-08-26');
  });

  it('마지막으로 성공한 날짜까지만 올린다 (FR-MO-014)', async () => {
    const { repo, recorded } = stubState({ lastCovered: '2026-08-23' });
    const { kto } = stubKto({
      '20260824': [item()], '20260825': [item()], '20260826': [item()],
    });
    await job(kto, repo).run();

    expect(recorded[0]).toMatchObject({ status: 'OK', lastCovered: '2026-08-26' });
  });
});

describe('0건과 실패 (FR-MO-014 · 015)', () => {
  it('🔴 평일 0건이면 last_covered 를 올리지 않는다', async () => {
    /*
     * 공사가 그날 분을 아직 안 올렸을 수 있다. 처리한 것으로 치면 그 날짜의 변경을
     * 영영 못 본다 — 다음 배치가 그 다음 날부터 보기 때문이다.
     */
    const { repo, recorded } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto({ '20260826': [] });
    const result = await job(kto, repo).run();

    expect(result.status).toBe('EMPTY');
    expect(result.covered).toBeNull();
    expect(recorded[0]?.lastCovered).toBeUndefined();
  });

  it('🔴 중간에 0건이 나오면 거기서 멈춘다', async () => {
    const { repo, recorded } = stubState({ lastCovered: '2026-08-23' });
    const { kto, calls } = stubKto({
      '20260824': [item()], '20260825': [], '20260826': [item()],
    });
    const result = await job(kto, repo).run();

    // 08-25 에서 멈춘다. 건너뛰고 08-26 을 처리하면 08-25 를 영영 못 본다
    expect(calls).toEqual(['20260824', '20260825']);
    expect(result.covered).toBe('2026-08-24');
    expect(recorded[0]?.lastCovered).toBe('2026-08-24');
  });

  it('🔴 조회가 실패하면 그 날짜를 넘기지 않는다', async () => {
    const { repo, recorded } = stubState({ lastCovered: '2026-08-23' });
    const { kto, calls } = stubKto({
      '20260824': [item()],
      '20260825': new KtoFetchError('areaBasedSyncList2', 'HTTP 503', 503),
      '20260826': [item()],
    });
    const result = await job(kto, repo).run();

    expect(result.status).toBe('FAILED');
    expect(calls).toEqual(['20260824', '20260825']);
    // 성공한 08-24 까지만 올린다
    expect(recorded[0]).toMatchObject({ status: 'FAILED', lastCovered: '2026-08-24' });
  });

  it('던지지 않는다 — 배치가 죽으면 다음 실행까지 아무것도 안 남는다', async () => {
    const { repo } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto({ '20260826': new KtoFetchError('areaBasedSyncList2', '끊김') });
    await expect(job(kto, repo).run()).resolves.toMatchObject({ status: 'FAILED' });
  });
});

describe('예산 (FR-OP-002)', () => {
  it('🔴 예산이 없으면 그 자리에서 멈추고 처리한 데까지만 올린다', async () => {
    const { repo, recorded } = stubState({ lastCovered: '2026-08-23' });
    const { kto, calls } = stubKto({
      '20260824': [item()], '20260825': [item()], '20260826': [item()],
    });
    let left = 2;
    const result = await job(kto, repo, { hasBudget: () => left-- > 0 }).run();

    expect(calls).toEqual(['20260824', '20260825']);
    expect(result.covered).toBe('2026-08-25');
    // 남은 날짜는 다음 배치가 이어 받는다
    expect(recorded[0]?.lastCovered).toBe('2026-08-25');
  });
});

describe('응답 해석 (FR-MO-002 · 012)', () => {
  it('🔴 공사 원문을 담지 않는다', () => {
    // 담으면 그대로 로그와 알림으로 새어 나간다 (DB 명세서 6-4)
    const parsed = toSyncedContent(item());
    expect(Object.keys(parsed).sort()).toEqual(
      ['contentId', 'contentTypeId', 'createdTime', 'modifiedTime', 'showFlag'],
    );
    expect(JSON.stringify(parsed)).not.toContain('강릉 국가유산야행');
    expect(JSON.stringify(parsed)).not.toContain('firstimage');
  });

  it('🔴 비표출을 같은 응답에서 읽는다 — 별도 조회를 하지 않는다', async () => {
    const { repo } = stubState({ lastCovered: '2026-08-25' });
    const { kto, calls } = stubKto({
      '20260826': [item({ contentid: '1', showflag: '1' }), item({ contentid: '2', showflag: '0' })],
    });
    const result = await job(kto, repo).run();

    expect(result.contents.map((c) => c.showFlag)).toEqual(['1', '0']);
    // 비표출 감지를 위한 두 번째 호출이 없다 (FR-MO-012 · EI-KT-012)
    expect(calls).toHaveLength(1);
  });

  it('showflag 가 없으면 표출로 본다', () => {
    expect(toSyncedContent({ contentid: '1' }).showFlag).toBe('1');
  });
});

describe('2단계 — 영향 탐색 (FR-MO-013 · 030)', () => {
  const oneChange = { '20260826': [item({ contentid: '125790' })] };

  it('🔴 등록 상품에 든 것만 본다 — 전부 부르면 예산이 그것으로 끝난다', async () => {
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto({
      '20260826': [item({ contentid: '1' }), item({ contentid: '2' }), item({ contentid: '3' })],
    });
    const notif = stubNotifications({ withContent: { '2': [candidate({ productId: 7 })] } });

    const enriched: string[] = [];
    const result = await job(kto, state, {
      notifications: notif.repo,
      enrich: async (cs) => {
        enriched.push(...cs.map((c) => c.contentId));
        return cs.map((c) => ({ ...(c as ChangedContent), eventPeriod: null, ldongSignguCd: null, hashFrom: null, hashTo: null }));
      },
    }).run();

    // 셋 다 조회는 하되 상세 재호출은 등록된 하나만
    expect(notif.lookups).toEqual(['1', '2', '3']);
    expect(enriched).toEqual(['2']);
    expect(result.impacts).toEqual([{ productId: 7, condition: 1, kind: 'RISK' }]);
  });

  it('등록 상품에 하나도 없으면 상세를 부르지 않는다', async () => {
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto(oneChange);
    const notif = stubNotifications();
    let called = false;

    const result = await job(kto, state, {
      notifications: notif.repo,
      enrich: async (cs) => { called = true; return cs as never; },
    }).run();

    expect(called).toBe(false);
    expect(result.impacts).toEqual([]);
    expect(result.notified).toBe(0);
  });

  it('🔴 알림 본문에 공사 원문이 없다 (FR-MO-002)', async () => {
    /*
     * 상세 조회(`enrich`)가 원문을 달고 와도 본문에 담지 않는다. 필요한 필드만 골라
     * 담아야 한다 — 통째로 펼치면 알림 테이블에 원문이 남는다 (DB 명세서 6-4).
     */
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto(oneChange);
    const notif = stubNotifications({ withContent: { '125790': [candidate({ productId: 7 })] } });

    await job(kto, state, {
      notifications: notif.repo,
      enrich: async (cs) => cs.map((c) => ({
        ...(c as ChangedContent), eventPeriod: null, ldongSignguCd: null, hashFrom: null, hashTo: null,
        // 상세 조회가 달고 오는 원문들
        title: '강릉 국가유산야행', addr1: '강원특별자치도 강릉시', overview: '야간 개장 행사입니다',
      } as never)),
    }).run();

    expect(notif.saved).toHaveLength(1);
    const serialized = JSON.stringify(notif.saved[0]);
    for (const leak of ['강릉 국가유산야행', '강원특별자치도', '야간 개장', 'addr1', 'overview', 'title']) {
      expect(serialized, leak).not.toContain(leak);
    }
  });

  it('비표출 전환을 알림 본문에 남긴다', async () => {
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto({ '20260826': [item({ contentid: '125790', showflag: '0' })] });
    const notif = stubNotifications({ withContent: { '125790': [candidate({ productId: 7 })] } });

    await job(kto, state, { notifications: notif.repo }).run();
    expect((notif.saved[0]?.body as { hidden: boolean }).hidden).toBe(true);
  });

  it('🔴 조건 1 상품만 재검수를 건다', async () => {
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto(oneChange);
    // 조건 1 은 상품 7, 조건 2 는 상품 9 에 걸린다
    const notif = stubNotifications({
      withContent: { '125790': [candidate({ productId: 7 })] },
      watched: [candidate({ productId: 9, ldongSignguCd: '150' })],
    });

    const audited: number[] = [];
    const result = await job(kto, state, {
      notifications: notif.repo,
      requestAudit: async (id) => { audited.push(id); },
      enrich: async (cs) => cs.map((c) => ({
        ...(c as ChangedContent), eventPeriod: null, ldongSignguCd: '150', hashFrom: null, hashTo: null,
      })),
    }).run();

    expect(result.impacts.map((i) => [i.productId, i.condition])).toEqual([[7, 1], [9, 2]]);
    // 조건 2 는 그 콘텐츠가 일정에 없다. 재검수해도 달라질 게 없다
    expect(audited).toEqual([7]);
  });

  it('🔴 2단계가 실패해도 1단계 결과를 뒤집지 않는다', async () => {
    const { repo: state, recorded } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto(oneChange);
    const broken = {
      productsWithContent: async (): Promise<never> => { throw new Error('DB 끊김'); },
      watchedProducts: async () => [],
      insertMany: async () => 0,
    } as unknown as NotificationRepository;

    const result = await job(kto, state, { notifications: broken }).run();

    // 1단계는 성공했고 기준일도 올라갔다. 여기서 던지면 다음 배치가 1단계를 두 번 돈다
    expect(result.status).toBe('OK');
    expect(result.covered).toBe('2026-08-26');
    expect(recorded[0]?.lastCovered).toBe('2026-08-26');
    expect(result.impacts).toEqual([]);
  });

  it('한 상품 재검수가 실패해도 나머지는 건다', async () => {
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto({ '20260826': [item({ contentid: 'a' }), item({ contentid: 'b' })] });
    const notif = stubNotifications({
      withContent: { a: [candidate({ productId: 1 })], b: [candidate({ productId: 2 })] },
    });

    const audited: number[] = [];
    await job(kto, state, {
      notifications: notif.repo,
      requestAudit: async (id) => {
        if (id === 1) throw new Error('큐가 막혔다');
        audited.push(id);
      },
    }).run();

    expect(audited).toEqual([2]);
  });

  it('알림 저장소를 안 붙이면 1단계만 돈다', async () => {
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto(oneChange);
    const result = await job(kto, state).run();

    expect(result.contents).toHaveLength(1);
    expect(result.impacts).toEqual([]);
  });
});
