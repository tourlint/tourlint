import { describe, expect, it } from 'vitest';
import type { KtoClient } from '../external/kto';
import { KtoFetchError } from '../external/kto/kto.errors';
import type { BatchState, BatchStateRepository, BatchStatus, SystemSetting } from '../persistence/batch-state.repository';
import type { NotificationRepository, NotificationToSave } from '../persistence/notification.repository';
import { FINGERPRINT_FIELDS } from '@tourlint/shared';
import { buildContentFingerprint, type FingerprintSnapshot } from '../engine/fingerprint';
import type { ImpactCandidate } from './impact-finder';
import {
  DEFAULT_BATCH_WATCH_LIMIT, SyncBatchJob, changeKeyOf, readWatchLimit, toEventPeriod, toSyncedContent,
} from './sync-batch.job';

/** 한국 시간 문자열을 Date 로 */
const kst = (iso: string): Date => new Date(`${iso}+09:00`);

/** `areaBasedSyncList2` 응답 항목 하나 — 실제 픽스처의 필드 구성이다 */
const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  contentid: '2541883', contenttypeid: '15', modifiedtime: '20260819131329',
  showflag: '1', createdtime: '20220913132227',
  lDongRegnCd: '51', lDongSignguCd: '150',
  lclsSystm2: 'EV01', mapx: '128.8920940489', mapy: '37.7532215016',
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
    fetchDetail?: (contentId: string, contentTypeId: number) => Promise<Record<string, unknown>>;
    previousFingerprints?: (productId: number) => Promise<ReadonlyMap<string, FingerprintSnapshot>>;
    requestAudit?: (productId: number) => Promise<void>;
  } = {},
): SyncBatchJob =>
  new SyncBatchJob({
    kto, state,
    clock: () => kst(over.now ?? '2026-08-27T05:00:00'),
    hasBudget: over.hasBudget,
    notifications: over.notifications,
    fetchDetail: over.fetchDetail,
    previousFingerprints: over.previousFingerprints,
    requestAudit: over.requestAudit,
  });

/** `detailIntro2` 응답. 유형 12 의 지문 입력은 restdate · usetime 이다 */
const intro = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  restdate: '매주 월요일', usetime: '09:00~18:00', infocenter: '033-000-0000', ...over,
});

/** 그 응답으로 만들어지는 지문. 러너와 같은 함수를 쓴다 */
const hashOf = (raw: Record<string, unknown>, contentTypeId = 12): string =>
  buildContentFingerprint({ contentTypeId, raw }).fieldHash;

/** 상품이 직전 검수에서 남긴 지문 */
const snapshot = (raw: Record<string, unknown>, over: Partial<FingerprintSnapshot> = {}): FingerprintSnapshot => ({
  fieldNames: FINGERPRINT_FIELDS[12], fieldHash: hashOf(raw),
  showFlag: 1, ktoModifiedTime: '20260101000000', ...over,
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
      ['contentId', 'contentTypeId', 'createdTime', 'lclsSystm2', 'ldongRegnCd', 'ldongSignguCd',
        'mapX', 'mapY', 'modifiedTime', 'showFlag'],
    );
    for (const leak of ['강릉 국가유산야행', '강원특별자치도', 'firstimage', 'tel', 'zipcode']) {
      expect(JSON.stringify(parsed), leak).not.toContain(leak);
    }
  });

  it('🔴 좌표가 비면 0 이 아니라 없는 것으로 읽는다', () => {
    /*
     * `Number('')` 은 0 이다. 그대로 두면 좌표를 모르는 콘텐츠가 위도 0 · 경도 0 —
     * 기니만 앞바다 — 에 있는 것이 되어, 기회 알림 조건 6 의 우회거리가 지구 반 바퀴로
     * 나오거나 반대로 「0 이라 가깝다」가 된다.
     */
    for (const bad of ['', '  ', '0', 'x']) {
      const parsed = toSyncedContent(item({ mapx: bad, mapy: bad }));
      expect(parsed.mapX, bad).toBeNull();
      expect(parsed.mapY, bad).toBeNull();
    }
    expect(toSyncedContent(item({ mapx: '128.892', mapy: '37.753' })))
      .toMatchObject({ mapX: 128.892, mapY: 37.753 });
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

  it('🔴 상세는 행사와 조건 1 에만 부른다 — 시군구는 목록에 이미 있다', async () => {
    /*
     * 조건 2 의 시군구는 `areaBasedSyncList2` 응답에 `lDongSignguCd` 로 들어 있다 (실측).
     * 이걸 모르고 전부 상세를 부르면 하루 177콜, 예산 800건의 22% 가 여기서 나간다.
     *
     * 상세가 필요한 것은 둘뿐이다 — 행사(15)의 개최 기간과, 조건 1 에 걸린 것의 지문.
     */
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto({
      '20260826': [
        item({ contentid: '1', contenttypeid: '12' }),
        item({ contentid: '2', contenttypeid: '15' }),
        item({ contentid: '3', contenttypeid: '39' }),
        item({ contentid: '4', contenttypeid: '39' }),
      ],
    });
    const notif = stubNotifications({
      withContent: { '4': [candidate({ productId: 7 })] },
      watched: [candidate({ productId: 7 })],
    });

    const fetched: string[] = [];
    await job(kto, state, {
      notifications: notif.repo,
      fetchDetail: async (id) => { fetched.push(id); return intro(); },
    }).run();

    // 2 는 행사라서, 4 는 조건 1 에 걸려서. 1 · 3 은 안 부른다
    expect(fetched.sort()).toEqual(['2', '4']);
  });

  it('🔴 한 콘텐츠에 상세를 두 번 부르지 않는다', async () => {
    // 행사이면서 조건 1 에도 걸리면 한 응답으로 기간과 지문을 둘 다 쓴다
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto({ '20260826': [item({ contentid: 'f', contenttypeid: '15' })] });
    const notif = stubNotifications({
      withContent: { f: [candidate({ productId: 7 })] },
      watched: [candidate({ productId: 7 })],
    });

    const fetched: string[] = [];
    await job(kto, state, {
      notifications: notif.repo,
      fetchDetail: async (id) => { fetched.push(id); return intro(); },
    }).run();

    expect(fetched).toEqual(['f']);
  });

  it('🔴 조건 2 는 상세 재호출 없이 걸린다', async () => {
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto({ '20260826': [item({ contentid: 'x', contenttypeid: '12', lDongSignguCd: '150' })] });
    const notif = stubNotifications({ watched: [candidate({ productId: 9, ldongSignguCd: '150' })] });

    // fetchDetail 을 안 넘긴다 — 그래도 조건 2 는 걸려야 한다
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
      fetchDetail: async () => ({ eventstartdate: '20260905', eventenddate: '20260915' }),
    }).run();

    expect(result.impacts).toEqual([{ productId: 9, condition: 3, kind: 'RISK' }]);
  });

  it('🔴 감시 상품이 없으면 행사 상세를 안 부른다', async () => {
    // 조건 2 · 3 후보가 없으면 기간을 알아도 걸릴 곳이 없다
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto({ '20260826': [item({ contentid: 'f', contenttypeid: '15' })] });
    const notif = stubNotifications({ withContent: { other: [candidate({ productId: 7 })] }, watched: [] });
    let called = false;

    await job(kto, state, {
      notifications: notif.repo,
      fetchDetail: async () => { called = true; return intro(); },
    }).run();

    expect(called).toBe(false);
  });

  it('아무 상품도 감시 중이 아니면 아무것도 안 한다', async () => {
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto(oneChange);
    const notif = stubNotifications();

    const result = await job(kto, state, { notifications: notif.repo }).run();
    expect(result.impacts).toEqual([]);
    expect(result.notified).toBe(0);
  });

  it('🔴 예산이 떨어지면 남은 상세를 안 부른다', async () => {
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto({
      '20260826': [item({ contentid: 'f1', contenttypeid: '15' }), item({ contentid: 'f2', contenttypeid: '15' })],
    });
    const notif = stubNotifications({ watched: [candidate({ productId: 9 })] });

    // 1단계 한 콜 + 상세 한 건까지만 허용한다
    let left = 2;
    const fetched: string[] = [];
    await job(kto, state, {
      notifications: notif.repo,
      hasBudget: () => left-- > 0,
      fetchDetail: async (id) => { fetched.push(id); return intro(); },
    }).run();

    expect(fetched).toEqual(['f1']);
  });

  it('상세 한 건이 실패해도 나머지를 본다', async () => {
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto({
      '20260826': [item({ contentid: 'f1', contenttypeid: '15' }), item({ contentid: 'f2', contenttypeid: '15' })],
    });
    const notif = stubNotifications({ watched: [candidate({ productId: 9 })] });

    const fetched: string[] = [];
    await job(kto, state, {
      notifications: notif.repo,
      fetchDetail: async (id) => {
        fetched.push(id);
        if (id === 'f1') throw new Error('상세 조회 실패');
        return intro();
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
    // 허용 목록으로 본다. 목록 항목을 통째로 펼치면 여기가 걸린다
    expect(Object.keys(notif.saved[0]?.body ?? {}).sort())
      .toEqual(['condition', 'contentTypeId', 'hidden', 'modifiedTime']);

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

describe('지문 비교 — 판정 무관 변경은 안 알린다 (FR-MO-036 · DR-FP-011)', () => {
  const change = { '20260826': [item({ contentid: 'c1', contenttypeid: '12' })] };
  const detail = intro();

  /** 상품 7 이 조건 1 로 걸리는 기본 배치 */
  const setup = (previous: (productId: number) => Promise<ReadonlyMap<string, FingerprintSnapshot>>) => {
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto(change);
    const notif = stubNotifications({ withContent: { c1: [candidate({ productId: 7 })] } });
    const audited: number[] = [];
    return {
      notif, audited,
      run: () => job(kto, state, {
        notifications: notif.repo,
        fetchDetail: async () => detail,
        previousFingerprints: previous,
        requestAudit: async (id) => { audited.push(id); },
      }).run(),
    };
  };

  it('🔴 판정 필드가 그대로면 알리지도 재검수하지도 않는다', async () => {
    /*
     * 공사가 사진이나 설명만 고쳐도 `modifiedtime` 은 올라간다. 그때마다 알리면 헛알림이고,
     * 재검수까지 걸면 상품 하나에 상세 조회 여러 건이 그냥 나간다.
     */
    const s = setup(async () => new Map([['c1', snapshot(detail)]]));
    const result = await s.run();

    expect(result.impacts).toEqual([]);
    expect(s.notif.saved).toEqual([]);
    expect(s.audited).toEqual([]);
  });

  it('🔴 판정 필드가 바뀌면 알리고 지문 두 개를 함께 남긴다', async () => {
    const before = intro({ usetime: '10:00~17:00' });
    const s = setup(async () => new Map([['c1', snapshot(before)]]));
    const result = await s.run();

    expect(result.impacts).toEqual([{ productId: 7, condition: 1, kind: 'RISK' }]);
    expect(s.audited).toEqual([7]);
    expect(s.notif.saved[0]).toMatchObject({ hashFrom: hashOf(before), hashTo: hashOf(detail) });
  });

  it('🔴 직전 지문이 상품마다 다르다', async () => {
    /*
     * 콘텐츠 전역 최신 지문을 쓰면, 다른 상품이 먼저 검수해 지문을 갱신한 변경을 이 상품
     * 사용자는 못 본 채로 「이미 알렸다」고 넘긴다 (FR-RU-060).
     */
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto(change);
    const notif = stubNotifications({
      withContent: { c1: [candidate({ productId: 7 }), candidate({ productId: 8 })] },
    });

    const result = await job(kto, state, {
      notifications: notif.repo,
      fetchDetail: async () => detail,
      // 7 은 이미 이 지문을 봤고 8 은 옛 지문에 머물러 있다
      previousFingerprints: async (productId) => new Map([
        ['c1', snapshot(productId === 7 ? detail : intro({ usetime: '10:00~17:00' }))],
      ]),
    }).run();

    expect(result.impacts).toEqual([{ productId: 8, condition: 1, kind: 'RISK' }]);
  });

  it('🔴 두 상품이 같이 걸리면 각자의 직전 지문이 실린다', async () => {
    /*
     * 알림 행마다 `hashFrom` 이 다르다. 하나로 뭉쳐 쓰면 남의 지문이 실려 재노출 판정이
     * 어긋난다 — 무시한 알림이 다시 뜨거나, 새 변경이 막힌다.
     */
    const older = intro({ usetime: '09:00~17:00' });
    const newer = intro({ usetime: '09:00~17:30' });
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto(change);
    const notif = stubNotifications({
      withContent: { c1: [candidate({ productId: 7 }), candidate({ productId: 8 })] },
    });

    await job(kto, state, {
      notifications: notif.repo,
      fetchDetail: async () => detail,
      previousFingerprints: async (productId) =>
        new Map([['c1', snapshot(productId === 7 ? older : newer)]]),
    }).run();

    expect(notif.saved).toHaveLength(2);
    expect(notif.saved.map((n) => [n.productId, n.hashFrom])).toEqual([
      [7, hashOf(older)],
      [8, hashOf(newer)],
    ]);
  });

  it('🔴 직전 지문이 없으면 알린다 — 안 바뀌었다고 말할 수 없다 (FR-RU-051)', async () => {
    // 검수 러너는 FIRST 에 알리지 않는다. 그 자리에서 검수 중이기 때문이고, 배치는 다르다
    const s = setup(async () => new Map());
    const result = await s.run();

    expect(result.impacts).toEqual([{ productId: 7, condition: 1, kind: 'RISK' }]);
    expect(s.notif.saved[0]).toMatchObject({ hashFrom: null, hashTo: hashOf(detail) });
    expect(s.audited).toEqual([7]);
  });

  it('🔴 비표출 전환은 지문이 같아도 알린다 (R06-b)', async () => {
    // 운영시간·휴무일은 그대로인 채 내려가는 경우다. 지문만 보면 안 바뀐 것으로 읽힌다
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto({ '20260826': [item({ contentid: 'c1', contenttypeid: '12', showflag: '0' })] });
    const notif = stubNotifications({ withContent: { c1: [candidate({ productId: 7 })] } });

    const result = await job(kto, state, {
      notifications: notif.repo,
      fetchDetail: async () => detail,
      previousFingerprints: async () => new Map([['c1', snapshot(detail)]]),
    }).run();

    expect(result.impacts).toEqual([{ productId: 7, condition: 1, kind: 'RISK' }]);
    expect((notif.saved[0]?.body as { hidden: boolean }).hidden).toBe(true);
  });

  it('🔴 지문을 못 만들면 알린다', async () => {
    // 지원하지 않는 유형(25 등)은 지문 입력 필드가 없다. 비교 불가지 「안 바뀜」이 아니다
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto({ '20260826': [item({ contentid: 'c1', contenttypeid: '25' })] });
    const notif = stubNotifications({ withContent: { c1: [candidate({ productId: 7 })] } });

    const result = await job(kto, state, {
      notifications: notif.repo,
      fetchDetail: async () => detail,
      previousFingerprints: async () => new Map(),
    }).run();

    expect(result.impacts).toEqual([{ productId: 7, condition: 1, kind: 'RISK' }]);
    expect(notif.saved[0]).toMatchObject({ hashFrom: null, hashTo: null });
  });

  it('🔴 조건 2 · 3 알림에는 지문이 없다', async () => {
    /*
     * 그 콘텐츠는 어느 일정에도 없어 지문 이력이 없다. 없는 것을 지어내지 않는다 —
     * 대신 그 행들은 `uq_notif_change` 로 중복이 안 막힌다 (NULL 은 서로 다르게 취급된다).
     */
    const { repo: state } = stubState({ lastCovered: '2026-08-25' });
    const { kto } = stubKto({ '20260826': [item({ contentid: 'x', contenttypeid: '12', lDongSignguCd: '150' })] });
    const notif = stubNotifications({ watched: [candidate({ productId: 9, ldongSignguCd: '150' })] });

    await job(kto, state, { notifications: notif.repo }).run();

    expect(notif.saved[0]).toMatchObject({ condition: 2, hashFrom: null, hashTo: null });
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

describe('재노출 판정 키 (FR-MO-036 · DB 명세서 v1.7)', () => {
  const content = toSyncedContent(item({ contentid: 'c1', modifiedtime: '20260827120000' }));
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);

  it('지문이 있으면 전이를 키로 쓴다', () => {
    expect(changeKeyOf(content, { from: A, to: B })).toBe(`FP:${A}:${B}`);
    // 직전 지문이 없어도 키는 만들어진다 — NULL 을 남기면 제약이 안 걸린다
    expect(changeKeyOf(content, { from: null, to: B })).toBe(`FP:-:${B}`);
  });

  it('🔴 지문이 없으면 갱신 시각을 쓴다 — 키를 비우지 않는다', () => {
    /*
     * 조건 2 · 3 은 지문 이력이 없다. 여기서 NULL 을 돌려주면 `uq_notif_change` 가
     * NULL 이 든 행을 서로 다르게 봐서 중복이 통째로 안 막힌다.
     */
    expect(changeKeyOf(content, { from: null, to: null })).toBe('MT:20260827120000');
  });

  it('🔴 같은 콘텐츠라도 다른 변경이면 키가 다르다', () => {
    const later = toSyncedContent(item({ contentid: 'c1', modifiedtime: '20260828090000' }));
    // 새로운 변경이면 다시 노출돼야 한다 (FR-MO-036 뒷 문장)
    expect(changeKeyOf(later, { from: null, to: null }))
      .not.toBe(changeKeyOf(content, { from: null, to: null }));
    expect(changeKeyOf(content, { from: A, to: B }))
      .not.toBe(changeKeyOf(content, { from: B, to: A }));
  });

  it('🔴 조건 1 과 조건 2 의 키가 겹치지 않는다', () => {
    // 접두어가 없으면 지문 문자열과 시각 문자열이 우연히 같아질 여지를 남긴다
    expect(changeKeyOf(content, { from: A, to: B }).startsWith('FP:')).toBe(true);
    expect(changeKeyOf(content, { from: null, to: null }).startsWith('MT:')).toBe(true);
  });
});

describe('감시 대상 상한 (FR-MO-020)', () => {
  it('환경변수가 없으면 10 이다', () => {
    expect(readWatchLimit({})).toBe(DEFAULT_BATCH_WATCH_LIMIT);
    expect(DEFAULT_BATCH_WATCH_LIMIT).toBe(10);
  });

  it('환경변수를 읽는다', () => {
    expect(readWatchLimit({ BATCH_WATCH_LIMIT: '3' })).toBe(3);
  });

  it('🔴 0 · 음수 · 헛값은 설정 실수다 — 감시를 끄지 않는다', () => {
    for (const v of ['0', '-1', 'many', '', '2.5']) {
      expect(readWatchLimit({ BATCH_WATCH_LIMIT: v }), v).toBe(DEFAULT_BATCH_WATCH_LIMIT);
    }
  });
});
