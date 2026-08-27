import { describe, expect, it } from 'vitest';
import type { KtoClient } from '../external/kto';
import { KtoFetchError } from '../external/kto/kto.errors';
import type { BatchState, BatchStateRepository, BatchStatus, SystemSetting } from '../persistence/batch-state.repository';
import type { NotificationRepository, NotificationToSave } from '../persistence/notification.repository';
import type { EventPeriod, ImpactCandidate } from './impact-finder';
import { SyncBatchJob, toEventPeriod, toSyncedContent } from './sync-batch.job';

/** 한국 시간 문자열을 Date 로 */
const kst = (iso: string): Date => new Date(`${iso}+09:00`);

/** `areaBasedSyncList2` 응답 항목 하나 — 실제 픽스처의 필드 구성이다 */
const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  contentid: '2541883', contenttypeid: '15', modifiedtime: '20260819131329',
  showflag: '1', createdtime: '20220913132227',
  lDongRegnCd: '51', lDongSignguCd: '150',
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
    eventPeriod?: (contentId: string) => Promise<EventPeriod | null>;
    requestAudit?: (productId: number) => Promise<void>;
  } = {},
): SyncBatchJob =>
  new SyncBatchJob({
    kto, state,
    clock: () => kst(over.now ?? '2026-08-27T05:00:00'),
    hasBudget: over.hasBudget,
    notifications: over.notifications,
    eventPeriod: over.eventPeriod,
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
    productsWithContents: async (
      contentIds: readonly string[],
    ): Promise<ReadonlyMap<string, readonly ImpactCandidate[]>> => {
      lookups.push(...contentIds);
      const out = new Map<string, readonly ImpactCandidate[]>();
      for (const id of contentIds) {
        const found = spec.withContent?.[id];
        if (found !== undefined && found.length > 0) out.set(id, found);
      }
      return out;
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
    /*
     * 담으면 그대로 로그와 알림으로 새어 나간다 (DB 명세서 6-4).
     *
     * **허용 목록으로 본다.** 응답에 필드가 늘거나 우리가 하나를 더 담으면 여기가 걸린다 —
     * 늘릴 때마다 그게 코드인지 원문인지 판단하게 하려는 검사다. 법정동 코드는 코드라
     * 담아도 되고, `title` · `addr1` · `firstimage` 는 원문이라 안 된다.
     */
    const parsed = toSyncedContent(item());
    expect(Object.keys(parsed).sort()).toEqual(
      ['contentId', 'contentTypeId', 'createdTime', 'ldongRegnCd', 'ldongSignguCd', 'modifiedTime', 'showFlag'],
    );
    for (const leak of ['강릉 국가유산야행', '강원특별자치도', 'firstimage', 'tel', 'zipcode']) {
      expect(JSON.stringify(parsed), leak).not.toContain(leak);
    }
  });

  it('🔴 법정동 코드가 비면 없는 것으로 읽는다', () => {
    // 실측에서 `areacode` · `sigungucode` 가 빈 문자열로 온다. `'' === ''` 로 묶이면
    // 지역을 모르는 것들이 서로 같은 지역인 셈이 돼 조건 2 가 엉뚱하게 걸린다
    const parsed = toSyncedContent(item({ lDongRegnCd: '', lDongSignguCd: '  ' }));
    expect(parsed.ldongRegnCd).toBeNull();
    expect(parsed.ldongSignguCd).toBeNull();
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

  it('🔴 상세 재호출은 행사에만 건다 — 시군구는 목록에 이미 있다', async () => {
    /*
     * 조건 2 의 시군구는 `areaBasedSyncList2` 응답에 `lDongSignguCd` 로 들어 있다 (실측).
     * 이걸 모르고 상세를 부르면 하루 177콜, 예산 800건의 22% 가 여기서 나간다.
     * 기간이 있어야 아는 것은 행사(15)뿐이다.
     */
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto({
      '20260826': [
        item({ contentid: '1', contenttypeid: '12' }),
        item({ contentid: '2', contenttypeid: '15' }),
        item({ contentid: '3', contenttypeid: '39' }),
      ],
    });
    const notif = stubNotifications({ watched: [candidate({ productId: 7 })] });

    const fetched: string[] = [];
    await job(kto, state, {
      notifications: notif.repo,
      eventPeriod: async (id) => { fetched.push(id); return null; },
    }).run();

    expect(fetched).toEqual(['2']);
  });

  it('🔴 조건 2 는 상세 재호출 없이 걸린다', async () => {
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto({ '20260826': [item({ contentid: 'x', contenttypeid: '12', lDongSignguCd: '150' })] });
    const notif = stubNotifications({ watched: [candidate({ productId: 9, ldongSignguCd: '150' })] });

    // eventPeriod 를 안 넘긴다 — 그래도 조건 2 는 걸려야 한다
    const result = await job(kto, state, { notifications: notif.repo }).run();
    expect(result.impacts).toEqual([{ productId: 9, condition: 2, kind: 'RISK' }]);
  });

  it('🔴 조건 3 은 가져온 행사기간으로 걸린다', async () => {
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    // 시군구를 어긋나게 둬서 조건 2 가 아니라 조건 3 으로 걸리는 것을 본다
    const { kto } = stubKto({ '20260826': [item({ contentid: 'f', contenttypeid: '15', lDongSignguCd: '110' })] });
    const notif = stubNotifications({
      watched: [candidate({ productId: 9, ldongSignguCd: '150', startDate: '2026-09-10', nights: 1 })],
    });

    const result = await job(kto, state, {
      notifications: notif.repo,
      eventPeriod: async () => ({ start: '2026-09-05', end: '2026-09-15' }),
    }).run();

    expect(result.impacts).toEqual([{ productId: 9, condition: 3, kind: 'RISK' }]);
  });

  it('🔴 감시 중인 상품이 없으면 행사기간을 안 부른다', async () => {
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto({ '20260826': [item({ contenttypeid: '15' })] });
    const notif = stubNotifications();
    let called = false;

    const result = await job(kto, state, {
      notifications: notif.repo,
      eventPeriod: async () => { called = true; return null; },
    }).run();

    expect(called).toBe(false);
    expect(result.impacts).toEqual([]);
  });

  it('🔴 예산이 떨어지면 남은 행사를 안 부른다', async () => {
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto({
      '20260826': [item({ contentid: 'f1', contenttypeid: '15' }), item({ contentid: 'f2', contenttypeid: '15' })],
    });
    const notif = stubNotifications({ watched: [candidate({ productId: 9 })] });

    // 1단계 한 콜 + 행사 한 건까지만 허용한다
    let left = 2;
    const fetched: string[] = [];
    await job(kto, state, {
      notifications: notif.repo,
      hasBudget: () => left-- > 0,
      eventPeriod: async (id) => { fetched.push(id); return null; },
    }).run();

    expect(fetched).toEqual(['f1']);
  });

  it('행사 한 건이 실패해도 나머지를 본다', async () => {
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto({
      '20260826': [item({ contentid: 'f1', contenttypeid: '15' }), item({ contentid: 'f2', contenttypeid: '15' })],
    });
    const notif = stubNotifications({ watched: [candidate({ productId: 9 })] });

    const fetched: string[] = [];
    await job(kto, state, {
      notifications: notif.repo,
      eventPeriod: async (id) => {
        fetched.push(id);
        if (id === 'f1') throw new Error('상세 조회 실패');
        return null;
      },
    }).run();

    expect(fetched).toEqual(['f1', 'f2']);
  });

  it('🔴 알림 본문에 공사 원문이 없다 (FR-MO-002)', async () => {
    /*
     * 동기화 목록 항목에 `title` · `addr1` · `firstimage` 가 실려 온다. 필요한 필드만
     * 골라 담아야 한다 — 통째로 펼치면 알림 테이블에 원문이 남는다 (DB 명세서 6-4).
     */
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto(oneChange);
    const notif = stubNotifications({ withContent: { '125790': [candidate({ productId: 7 })] } });

    await job(kto, state, { notifications: notif.repo }).run();

    expect(notif.saved).toHaveLength(1);
    const serialized = JSON.stringify(notif.saved[0]);
    for (const leak of ['강릉 국가유산야행', '강원특별자치도', 'addr1', 'firstimage', 'title']) {
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
    }).run();

    expect(result.impacts.map((i) => [i.productId, i.condition])).toEqual([[7, 1], [9, 2]]);
    // 조건 2 는 그 콘텐츠가 일정에 없다. 재검수해도 달라질 게 없다
    expect(audited).toEqual([7]);
  });

  it('🔴 2단계가 실패해도 1단계 결과를 뒤집지 않는다', async () => {
    const { repo: state, recorded } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto(oneChange);
    const broken = {
      productsWithContents: async (): Promise<never> => { throw new Error('DB 끊김'); },
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

describe('행사 개최 기간 해석 (조건 3)', () => {
  it('YYYYMMDD 를 ISO 로 읽는다', () => {
    // 실제 픽스처 값 (type15_695592)
    expect(toEventPeriod({ eventstartdate: '20260404', eventenddate: '20260411' }))
      .toEqual({ start: '2026-04-04', end: '2026-04-11' });
  });

  it('🔴 한쪽이라도 없으면 판정하지 않는다', () => {
    /*
     * 기간 결측을 「안 겹친다」로 읽지 않는다. 모르는 것을 근거로 알리지 않을 뿐,
     * 겹치지 않는다고 말하지도 않는다 (FR-RU-051 과 같은 취지).
     */
    expect(toEventPeriod({ eventstartdate: '20260404', eventenddate: '' })).toBeNull();
    expect(toEventPeriod({ eventenddate: '20260411' })).toBeNull();
    expect(toEventPeriod({})).toBeNull();
  });

  it('🔴 날짜가 아닌 8자리를 날짜로 받아들이지 않는다', () => {
    // 자릿수만 보면 20261352 가 통과해 「2026-13-52 부터」라는 기간이 생긴다
    expect(toEventPeriod({ eventstartdate: '20261352', eventenddate: '20261353' })).toBeNull();
    expect(toEventPeriod({ eventstartdate: '20260230', eventenddate: '20260301' })).toBeNull();
    expect(toEventPeriod({ eventstartdate: '2026-04-04', eventenddate: '2026-04-11' })).toBeNull();
  });
});
