import { describe, expect, it } from 'vitest';
import {
  MAX_DETOUR_METERS, OPPORTUNITY_CAP_PER_PRODUCT, capOpportunities, detourMeters, dwellOf, freeSlots,
  isNewlyRegistered, matchByDetour, matchByFreeSlot, matchByMissingType,
  type OpportunityCandidate, type OpportunityItem,
} from './opportunity';
import { straightMeters } from '../engine/geo';
import { toSyncedContent } from './sync-batch.job';

/** 강릉 경포대 근처 좌표들 */
const GYEONGPO = { x: 128.8961, y: 37.7955 };
const OJUKHEON = { x: 128.8779, y: 37.7793 };   // 경포대에서 ~2.1km
const SEOUL = { x: 126.9780, y: 37.5665 };      // 아주 멀다

const content = (over: Record<string, unknown> = {}): ReturnType<typeof toSyncedContent> =>
  toSyncedContent({
    contentid: 'c1', contenttypeid: '14', modifiedtime: '20260827120000',
    createdtime: '20260827120000', showflag: '1',
    lDongRegnCd: '51', lDongSignguCd: '150', lclsSystm2: 'VE07',
    mapx: String(OJUKHEON.x), mapy: String(OJUKHEON.y), ...over,
  });

const item = (over: Partial<OpportunityItem> = {}): OpportunityItem => ({
  dayNo: 1, seq: 1, startTime: '10:00', endTime: '11:00',
  mapX: GYEONGPO.x, mapY: GYEONGPO.y, ...over,
});

const candidate = (over: Partial<OpportunityCandidate> = {}): OpportunityCandidate => ({
  productId: 1, startDate: '2026-09-10', nights: 1, ldongRegnCd: '51', ldongSignguCd: '150',
  missingLcls2: ['VE07'], items: [item()], ...over,
});

describe('조건 4 — 그 상품에 없는 유형이 생겼다 (FR-MO-030 ④ · FR-MO-051)', () => {
  it('결손 유형과 맞으면 기회로 건다', () => {
    expect(matchByMissingType(content(), [candidate()]))
      .toEqual([{ productId: 1, condition: 4, kind: 'OPPORTUNITY' }]);
  });

  it('🔴 이미 담고 있는 유형은 안 건다', () => {
    /*
     * 「유형이 유사」를 문자 그대로 읽으면 실측 177건이 중분류 35개에 흩어져 있어
     * 중분류 6개를 담은 상품 하나가 하루 115건에 걸린다. 알림이 아니라 소음이다.
     */
    expect(matchByMissingType(content({ lclsSystm2: 'FD01' }), [candidate()])).toEqual([]);
  });

  it('🔴 중분류를 모르면 안 건다', () => {
    // 「유형을 모른다」를 「결손을 채운다」로 읽을 수 없다
    expect(matchByMissingType(content({ lclsSystm2: '' }), [candidate()])).toEqual([]);
  });

  it('🔴 시군구가 다르면 안 건다 — 반영할 수 없는 제안이다', () => {
    // 서울 신규 콘텐츠를 강릉 상품에 제안하면 안 된다 (FR-MO-052)
    expect(matchByMissingType(content({ lDongSignguCd: '110' }), [candidate()])).toEqual([]);
    expect(matchByMissingType(content({ lDongSignguCd: '' }), [candidate()])).toEqual([]);
  });
});

describe('빈 시간대 (조건 5)', () => {
  it('항목 사이 간격과 마지막 뒤를 함께 찾는다', () => {
    const slots = freeSlots([
      item({ seq: 1, startTime: '10:00', endTime: '11:00' }),
      item({ seq: 2, startTime: '13:00', endTime: '14:00' }),
    ], 90);
    // 11:00~13:00 사이와 14:00~21:00 꼬리
    expect(slots.map((s) => s.minutes)).toEqual([120, 420]);
    expect(slots.map((s) => s.after?.seq ?? null)).toEqual([2, null]);
  });

  it('🔴 종료시간을 모르면 그 뒤를 안 센다', () => {
    /*
     * 언제 끝나는지 모르면 그 뒤가 비었는지도 모른다. 비었다고 치면 이미 꽉 찬 일정에
     * 제안이 들어간다 (FR-RU-051 과 같은 취지).
     */
    const slots = freeSlots([
      item({ seq: 1, startTime: '10:00', endTime: null }),
      item({ seq: 2, startTime: '18:00', endTime: '19:00' }),
    ], 60);
    // 10:00~18:00 은 비어 보이지만 1번이 언제 끝나는지 모른다. 2번 뒤 꼬리만 남는다
    expect(slots.map((s) => s.before.seq)).toEqual([2]);
  });

  it('🔴 시각 모양이 아니면 안 센다 — 00:00 으로 읽지 않는다', () => {
    /*
     * 범위 검사(`25:00` · `10:70`)만으로는 부족하다. 자릿수와 앞뒤를 안 보면 `9:30` 이나
     * `10:30:00` 이 통과해 엉뚱한 분으로 읽힌다.
     */
    for (const bad of ['', '1000', '25:00', '10:70', '9:30', '10:30:00', 'a10:30']) {
      expect(freeSlots([item({ endTime: bad })], 30), bad).toEqual([]);
    }
  });

  it('마지막 항목 뒤도 본다', () => {
    const slots = freeSlots([item({ seq: 1, startTime: '10:00', endTime: '11:00' })], 120);
    expect(slots).toHaveLength(1);
    expect(slots[0]?.after).toBeNull();
    expect(slots[0]?.minutes).toBe(600); // 11:00 ~ 21:00
  });

  it('🔴 일차를 가로지른 간격을 만들지 않는다', () => {
    /*
     * 1일차 낮에 끝난 뒤와 2일차 저녁 사이를 이으면 「6시간 비어 있다」가 된다. 실제로는
     * 밤을 사이에 둔 다른 날이라 거기에 일정을 넣을 수 없다.
     */
    const slots = freeSlots([
      item({ dayNo: 1, seq: 1, startTime: '10:00', endTime: '12:00' }),
      item({ dayNo: 2, seq: 2, startTime: '18:00', endTime: '19:00' }),
    ], 60);
    for (const slot of slots) {
      expect(slot.after?.dayNo ?? slot.before.dayNo, JSON.stringify(slot)).toBe(slot.before.dayNo);
    }
    // 각 일차의 꼬리만 남는다
    expect(slots.map((s) => s.dayNo)).toEqual([1, 2]);
  });

  it('간격이 모자라면 안 센다', () => {
    const slots = freeSlots([
      item({ seq: 1, startTime: '10:00', endTime: '11:00' }),
      item({ seq: 2, startTime: '11:30', endTime: '12:30' }),
    ], 60);
    // 30분 간격은 빠지고 12:30 뒤 꼬리만 남는다
    expect(slots.map((s) => s.before.seq)).toEqual([2]);
  });
});

describe('조건 5 — 넣을 자리가 있다', () => {
  const roomy = candidate({
    items: [
      item({ seq: 1, startTime: '10:00', endTime: '11:00' }),
      item({ seq: 2, startTime: '15:00', endTime: '16:00' }),
    ],
  });

  it('체류시간이 들어가면 건다', () => {
    expect(matchByFreeSlot(content(), [roomy], 120))
      .toEqual([{ productId: 1, condition: 5, kind: 'OPPORTUNITY' }]);
  });

  it('🔴 체류시간을 모르면 판정하지 않는다', () => {
    // 얼마나 걸리는지 모르는 것을 「들어간다」고 할 수 없다
    expect(matchByFreeSlot(content(), [roomy], null)).toEqual([]);
    expect(matchByFreeSlot(content(), [roomy], 0)).toEqual([]);
  });
});

describe('직선거리와 우회 (조건 6)', () => {
  it('두 좌표 사이 거리를 잰다', () => {
    // 경포대 ↔ 오죽헌 약 2.5km
    const d = straightMeters(GYEONGPO, OJUKHEON);
    expect(d).toBeGreaterThan(2000);
    expect(d).toBeLessThan(3000);
  });

  it('사이에 끼우면 늘어나는 만큼만 센다', () => {
    const from = item({ mapX: GYEONGPO.x, mapY: GYEONGPO.y });
    const to = item({ seq: 2, mapX: GYEONGPO.x, mapY: GYEONGPO.y });
    // 같은 자리로 돌아오는 구간에 오죽헌을 끼우면 왕복만큼 늘어난다
    const extra = detourMeters(from, to, OJUKHEON);
    expect(extra).toBeGreaterThan(4000);
  });

  it('🔴 좌표를 모르면 0 이 아니라 null 이다', () => {
    // 0 으로 치면 「우회가 전혀 없다」가 되어 아무 데나 걸린다
    expect(detourMeters(item({ mapX: null }), item({ seq: 2 }), OJUKHEON)).toBeNull();
    expect(detourMeters(item(), item({ seq: 2, mapY: null }), OJUKHEON)).toBeNull();
  });

  it('마지막 항목 뒤는 왕복으로 본다', () => {
    const extra = detourMeters(item({ mapX: GYEONGPO.x, mapY: GYEONGPO.y }), null, OJUKHEON);
    expect(extra).toBeCloseTo(Math.round(straightMeters(GYEONGPO, OJUKHEON) * 2), -1);
  });
});

describe('조건 6 — 우회가 크지 않다', () => {
  const roomy = candidate({
    items: [
      item({ seq: 1, startTime: '10:00', endTime: '11:00', mapX: GYEONGPO.x, mapY: GYEONGPO.y }),
      item({ seq: 2, startTime: '15:00', endTime: '16:00', mapX: GYEONGPO.x, mapY: GYEONGPO.y }),
    ],
  });

  it('가까우면 건다', () => {
    expect(matchByDetour(content(), [roomy], 120))
      .toEqual([{ productId: 1, condition: 6, kind: 'OPPORTUNITY' }]);
  });

  it('🔴 멀면 안 건다', () => {
    expect(matchByDetour(content({ mapx: String(SEOUL.x), mapy: String(SEOUL.y) }), [roomy], 120))
      .toEqual([]);
    expect(MAX_DETOUR_METERS).toBe(5000);
  });

  it('🔴 좌표가 없으면 판정하지 않는다', () => {
    expect(matchByDetour(content({ mapx: '', mapy: '' }), [roomy], 120)).toEqual([]);
  });

  it('🔴 넣을 자리가 없으면 거리와 무관하게 안 건다', () => {
    // 우회가 0 이어도 들어갈 시간이 없으면 제안할 수 없다
    const packed = candidate({
      items: [
        item({ seq: 1, startTime: '10:00', endTime: '11:00', mapX: OJUKHEON.x, mapY: OJUKHEON.y }),
        item({ seq: 2, startTime: '11:00', endTime: '20:59', mapX: OJUKHEON.x, mapY: OJUKHEON.y }),
      ],
    });
    expect(matchByDetour(content(), [packed], 120)).toEqual([]);
  });
});

describe('같은 시군구 — 시도 코드까지 (#616)', () => {
  it('🔴 시군구 번호가 같아도 시도가 다르면 안 건다 — 춘천(51-110)과 종로(11-110)', () => {
    const jongno = content({ lDongRegnCd: '11', lDongSignguCd: '110' });
    expect(matchByMissingType(jongno, [candidate({ ldongRegnCd: '51', ldongSignguCd: '110' })])).toEqual([]);
    expect(matchByMissingType(jongno, [candidate({ ldongRegnCd: '11', ldongSignguCd: '110' })])).toHaveLength(1);
  });
});

describe('새로 등록된 곳 (FR-MO-030 ④ · #616)', () => {
  it('이번 배치가 본 첫 날짜 뒤에 등록된 곳이다', () => {
    expect(isNewlyRegistered(content({ createdtime: '20260827093000' }), '2026-08-27')).toBe(true);
    expect(isNewlyRegistered(content({ createdtime: '20260901000000' }), '2026-08-27')).toBe(true);
  });

  it('🔴 오래된 곳이 고쳐진 것은 새로 등록된 곳이 아니다 — 동기화 목록에는 둘이 섞여 온다', () => {
    expect(isNewlyRegistered(content({ createdtime: '20220913132227', modifiedtime: '20260827120000' }), '2026-08-27')).toBe(false);
  });

  it('🔴 비표출은 넣을 수 없어 뺀다', () => {
    expect(isNewlyRegistered(content({ showflag: '0' }), '2026-08-27')).toBe(false);
  });

  it('등록 시각을 모르면 새로 등록된 곳으로 치지 않는다', () => {
    expect(isNewlyRegistered(content({ createdtime: '' }), '2026-08-27')).toBe(false);
  });
});

describe('기본 체류시간 (FR-IN-011)', () => {
  it('표에 있는 중분류는 그 값이고, 없으면 모른다', () => {
    expect(dwellOf('FD01')).toBe(60);
    expect(dwellOf('AC01')).toBeNull();
    expect(dwellOf(null)).toBeNull();
  });
});

describe('상품당 상한 (#616)', () => {
  const chance = (productId: number, condition: 4 | 5 | 6, contentId: string) => ({ productId, condition, contentId });

  it(`🔴 상품마다 ${String(OPPORTUNITY_CAP_PER_PRODUCT)}건까지만 남긴다 — 결손 유형(조건 4)이 먼저다`, () => {
    const { kept, dropped } = capOpportunities([
      chance(1, 6, 'a'), chance(1, 5, 'b'), chance(1, 5, 'c'), chance(1, 4, 'z'), chance(1, 6, 'd'),
    ]);
    expect(kept.map((k) => `${String(k.condition)}:${k.contentId}`)).toEqual(['4:z', '5:b', '5:c']);
    expect(dropped).toBe(2);
  });

  it('상품마다 따로 센다', () => {
    const { kept } = capOpportunities([
      chance(2, 5, 'a'), chance(1, 5, 'a'), chance(1, 5, 'b'), chance(2, 5, 'b'),
    ], 1);
    expect(kept.map((k) => `${String(k.productId)}:${k.contentId}`)).toEqual(['1:a', '2:a']);
  });

  it('같은 입력이면 들어온 순서와 상관없이 같은 것이 남는다 (NF-MT-001)', () => {
    const items = [chance(1, 5, 'c'), chance(1, 5, 'a'), chance(1, 5, 'b'), chance(1, 5, 'd')];
    expect(capOpportunities(items).kept).toEqual(capOpportunities([...items].reverse()).kept);
  });
});
