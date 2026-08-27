import { describe, expect, it } from 'vitest';
import {
  NEARBY_DAYS, kindOf, matchByContent, matchByEventPeriod, matchByRegion, mergeImpacts, travelDatesOf,
  type ChangedContent, type ImpactCandidate,
} from './impact-finder';

const candidate = (over: Partial<ImpactCandidate> = {}): ImpactCandidate => ({
  productId: 1, startDate: '2026-09-10', nights: 2, ldongSignguCd: '150', ...over,
});

const changed = (over: Partial<ChangedContent> = {}): ChangedContent => ({
  contentId: '125790', contentTypeId: '12', modifiedTime: '20260827120000',
  showFlag: '1', createdTime: '20220101000000',
  ldongRegnCd: '51', ldongSignguCd: '150',
  eventPeriod: null, hashFrom: 'a'.repeat(64), hashTo: 'b'.repeat(64),
  ...over,
});

describe('여행 일자', () => {
  it('출발일 + 박수만큼 편다', () => {
    expect(travelDatesOf(candidate({ startDate: '2026-09-10', nights: 2 })))
      .toEqual(['2026-09-10', '2026-09-11', '2026-09-12']);
    expect(travelDatesOf(candidate({ nights: 0 }))).toHaveLength(1);
  });
});

describe('분류 (FR-MO-031)', () => {
  it('조건 1–3 은 위험, 4–6 은 기회다', () => {
    expect(([1, 2, 3] as const).map(kindOf)).toEqual(['RISK', 'RISK', 'RISK']);
    expect(([4, 5, 6] as const).map(kindOf)).toEqual(['OPPORTUNITY', 'OPPORTUNITY', 'OPPORTUNITY']);
  });
});

describe('조건 2 — 같은 지역 (FR-MO-032)', () => {
  const detected = '2026-09-01';

  it('🔴 시군구가 다르면 안 걸린다', () => {
    /*
     * 시도만 같아도 알리면 그 지역 상품 전부에 알림이 간다.
     *
     * 날짜는 **창 안에 두고** 지역만 다르게 한다 — 날짜가 밖이면 그쪽 필터에 먼저 걸려
     * 지역 필터가 없어도 통과해 버린다.
     */
    const nearby = { startDate: '2026-09-02', nights: 0 };
    expect(matchByRegion(changed({ ldongSignguCd: '150' }), [candidate({ ...nearby, ldongSignguCd: '150' })], detected))
      .toHaveLength(1);
    expect(matchByRegion(changed({ ldongSignguCd: '150' }), [candidate({ ...nearby, ldongSignguCd: '110' })], detected))
      .toEqual([]);
  });

  it('🔴 여행일이 ±7일 밖이면 안 걸린다', () => {
    // 두 달 뒤 출발 상품에 오늘의 변경을 알려도 할 수 있는 게 없다
    const far = candidate({ startDate: '2026-11-01', nights: 0 });
    expect(matchByRegion(changed(), [far], detected)).toEqual([]);
  });

  it('±7일 경계를 포함한다', () => {
    expect(NEARBY_DAYS).toBe(7);
    const edge = candidate({ startDate: '2026-09-08', nights: 0 }); // 감지일 +7
    expect(matchByRegion(changed(), [edge], detected)).toHaveLength(1);
    const over = candidate({ startDate: '2026-09-09', nights: 0 }); // +8
    expect(matchByRegion(changed(), [over], detected)).toEqual([]);
  });

  it('여행 일자 중 하루라도 창 안이면 걸린다', () => {
    // 출발은 밖이지만 2일차가 안이다
    const spanning = candidate({ startDate: '2026-09-07', nights: 2 });
    expect(matchByRegion(changed(), [spanning], detected)).toHaveLength(1);
  });

  it('콘텐츠의 시군구를 모르면 판정하지 않는다', () => {
    expect(matchByRegion(changed({ ldongSignguCd: null }), [candidate()], detected)).toEqual([]);
  });
});

describe('조건 3 — 행사기간 겹침', () => {
  const period = { start: '2026-09-11', end: '2026-09-13' };

  it('여행일과 겹치면 걸린다', () => {
    expect(matchByEventPeriod(changed({ eventPeriod: period }), [candidate()])).toHaveLength(1);
  });

  it('안 겹치면 안 걸린다', () => {
    const before = candidate({ startDate: '2026-09-01', nights: 2 });
    expect(matchByEventPeriod(changed({ eventPeriod: period }), [before])).toEqual([]);
  });

  it('🔴 기간을 모르면 판정하지 않는다 — 「안 겹친다」로 읽지 않는다', () => {
    expect(matchByEventPeriod(changed({ eventPeriod: null }), [candidate()])).toEqual([]);
    expect(matchByEventPeriod(changed({ eventPeriod: { start: '2026-09-11', end: null } }), [candidate()]))
      .toEqual([]);
  });
});

describe('합치기', () => {
  it('🔴 상품당 하나만 남기고 번호가 작은 쪽이 이긴다', () => {
    /*
     * 같은 상품이 조건 1 과 2 에 다 걸리면 조건 1 로 알린다. 두 번 알리면 사용자는
     * 문제가 둘인 줄 안다.
     */
    const merged = mergeImpacts(
      matchByContent([candidate({ productId: 7 })]),
      matchByRegion(changed(), [candidate({ productId: 7 })], '2026-09-11'),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ productId: 7, condition: 1, kind: 'RISK' });
  });

  it('다른 상품은 각자 남는다', () => {
    const merged = mergeImpacts(
      matchByContent([candidate({ productId: 3 })]),
      matchByEventPeriod(
        changed({ eventPeriod: { start: '2026-09-10', end: '2026-09-12' } }),
        [candidate({ productId: 5 })],
      ),
    );
    expect(merged.map((m) => [m.productId, m.condition])).toEqual([[3, 1], [5, 3]]);
  });

  it('상품 id 순으로 고정한다 — 순서가 흔들리면 같은 배치가 달라 보인다', () => {
    const merged = mergeImpacts(matchByContent([
      candidate({ productId: 9 }), candidate({ productId: 2 }), candidate({ productId: 5 }),
    ]));
    expect(merged.map((m) => m.productId)).toEqual([2, 5, 9]);
  });
});
