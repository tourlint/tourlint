import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KOREAN_HOLIDAYS } from '../engine/calendar/holidays';
import { parseOperatingInfo } from '../engine/normalize/parse';
import type { AuditItem, Finding } from '../engine/rules/types';
import { InMemoryApiCallLogger } from '../external/api-call-log';
import { createKtoClient } from '../external/kto';
import { MIN_TRANSFER_MINUTES, lastRepeated, planInsertion, proposeLocalPatches } from './patch-local';
import { proposeReplacements, rankCandidates } from './patch-remote';
import { MAX_PATCHES_PER_FINDING } from './patch-types';

const FIXTURE_ENV = { KTO_MODE: 'fixture', KTO_FIXTURE_DIR: join(__dirname, '../../../../fixtures/kto') };

let nextId = 1;
interface Spec {
  readonly day?: number; readonly start?: string; readonly end?: string | null;
  readonly type?: AuditItem['itemType']; readonly label?: string;
  readonly rest?: string; readonly use?: string;
  readonly mapX?: number | null; readonly mapY?: number | null;
  readonly contentId?: string;
}
function item(s: Spec = {}): AuditItem {
  const normalized = s.rest === undefined && s.use === undefined
    ? null
    : parseOperatingInfo({ contentTypeId: 12, raw: { restdate: s.rest ?? '', usetime: s.use ?? '' } });
  return {
    id: nextId++, dayNo: s.day ?? 1, seq: nextId, date: `2026-10-${String(21 + (s.day ?? 1)).padStart(2, '0')}`,
    startTime: s.start ?? '10:00', endTime: s.end === undefined ? '11:00' : s.end,
    endTimeSource: 'INPUT', lclsSystm1: null, lclsSystm2: null, lclsSystm3: null,
    mapX: s.mapX === undefined ? 128.8961 : s.mapX, mapY: s.mapY === undefined ? 37.7952 : s.mapY,
    itemType: s.type ?? 'SIGHT', placeLabel: s.label ?? '장소', matchStatus: 'CONFIRMED',
    content: {
      ktoContentId: s.contentId ?? String(nextId), contentTypeId: 12,
      normalized, showFlag: 1, eventPeriod: null, changeVerdict: null,
    },
  };
}

const finding = (over: Partial<Finding>): Finding => ({
  ruleCode: 'R01', ruleVersion: '1.0.0', severity: 'BLOCKER', reasonCode: 'REST_DAY_CONFLICT',
  targetItemId: 1, message: '', evidence: {}, requiresExternal: false, externalSource: null,
  needsConfirmation: false, ...over,
});

describe('수정안은 표시 문구를 담지 않는다 (DR-PR-001)', () => {
  it('payload 에 명칭이 없다', async () => {
    const target = item({ rest: '연중무휴', use: '09:00~18:00' });
    const patches = await proposeReplacements(target, {
      kto: createKtoClient(new InMemoryApiCallLogger(), FIXTURE_ENV),
    });
    expect(patches.length).toBeGreaterThan(0);
    for (const p of patches) {
      const s = JSON.stringify(p);
      expect(s).not.toContain('title');
      expect(s).not.toContain('label');
      expect(p.payload).toHaveProperty('ktoContentId');
    }
  });
});

describe('R01 — 휴무 충돌이면 날짜를 바꾼다 (FR-RU-013①)', () => {
  it('그 콘텐츠가 열려 있는 다른 일차를 고른다', () => {
    // 매주 화요일 휴무. 1일차(10/22 목)는 열려 있다
    const target = item({ day: 2, rest: '매주 수요일', use: '09:00~18:00', label: '오죽헌' });
    const other = item({ day: 1 });
    const [p] = proposeLocalPatches({
      finding: finding({ targetItemId: target.id }),
      items: [target, other], holidays: KOREAN_HOLIDAYS,
    });
    expect(p).toMatchObject({ type: 'TIME_SHIFT', targetItemId: target.id });
    expect((p?.payload as { newDayNo: number }).newDayNo).toBe(1);
  });

  it('🔴 옮긴 날의 다른 항목에 맞붙여 놓지 않는다', () => {
    /*
     * 실제로 그렇게 냈다 — 화요일 휴무인 식사를 2일차 12:00 으로 옮겨 앞 식사(11:30~12:00)에
     * 맞붙였고, 반영 후 재검수에서 「이동에 10분이 걸리는데 배정된 시간은 0분」 오류가 났다.
     * 날짜만 보고 시각을 그대로 들고 간 것이 원인이다.
     */
    const target = item({ day: 1, start: '12:00', end: '13:00', type: 'MEAL',
                          rest: '매주 화요일', use: '09:00~21:00', label: '가람집옹심이' });
    const before = item({ day: 2, start: '11:30', end: '12:00', type: 'MEAL', label: '감천골' });
    const [p] = proposeLocalPatches({
      finding: finding({ targetItemId: target.id }),
      items: [target, before], holidays: KOREAN_HOLIDAYS,
    });

    const payload = p?.payload as { newDayNo: number; newStartTime: string; newEndTime?: string };
    expect(payload.newDayNo).toBe(2);
    // 소요시간(1시간)은 유지된다
    expect(payload.newEndTime).toBeDefined();

    /*
     * 어디에 놓든 상관없다. **그 날의 다른 항목과 최소 여유만큼 떨어져 있으면** 된다 —
     * 앞이든 뒤든. 자리를 특정 시각으로 못 박으면 배치 규칙을 바꿀 때마다 검사가 깨진다.
     */
    const min = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const from = min(payload.newStartTime);
    const to = min(payload.newEndTime as string);
    // 앞에 놓였으면 왼쪽 간격이, 뒤에 놓였으면 오른쪽 간격이 양수다. 겹치면 둘 다 음수다
    const gap = Math.max(min(before.startTime) - to, from - min(before.endTime as string));
    expect(gap, `${payload.newStartTime}~${payload.newEndTime} vs 11:30~12:00`)
      .toBeGreaterThanOrEqual(MIN_TRANSFER_MINUTES);
  });

  it('🔴 좁은 틈에 억지로 끼워 넣지 않는다', () => {
    /*
     * 소요시간만큼만 보고 자리를 잡으면, 앞 여유를 두는 순간 뒤가 밀려 다음 항목을 덮는다.
     * 앞뒤 여유까지 들어가는 틈만 자리로 친다.
     */
    const target = item({ day: 1, start: '12:00', end: '13:00',
                          rest: '매주 화요일', use: '09:00~21:00' });
    const a = item({ day: 2, start: '09:00', end: '10:00' });
    const b = item({ day: 2, start: '11:00', end: '12:00' }); // a 와 60분 틈뿐이다
    const [p] = proposeLocalPatches({
      finding: finding({ targetItemId: target.id }),
      items: [target, a, b], holidays: KOREAN_HOLIDAYS,
    });

    const payload = p?.payload as { newStartTime: string; newEndTime?: string };
    const min = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const from = min(payload.newStartTime);
    const to = min(payload.newEndTime as string);
    // 그 날 어느 항목과도 겹치지 않는다
    for (const other of [a, b]) {
      const gap = Math.max(min(other.startTime) - to, from - min(other.endTime as string));
      expect(gap, `${payload.newStartTime}~${payload.newEndTime} vs ${other.startTime}~${String(other.endTime)}`)
        .toBeGreaterThanOrEqual(MIN_TRANSFER_MINUTES);
    }
  });

  it('🔴 숙박 뒤로는 넣지 않는다', () => {
    // 체크인은 그 날 일정의 끝이다 (R07 `daySpan`). 그 뒤에 관광을 넣으면 밤에 나가란 말이 된다
    const target = item({ day: 1, start: '12:00', end: '13:00',
                          rest: '매주 화요일', use: '09:00~21:00' });
    const lodging = item({ day: 2, start: '17:30', end: null, type: 'LODGING', label: '강릉강변스테이' });
    const morning = item({ day: 2, start: '09:00', end: '17:00' });
    expect(proposeLocalPatches({
      finding: finding({ targetItemId: target.id }),
      items: [target, morning, lodging], holidays: KOREAN_HOLIDAYS,
    })).toHaveLength(0);
  });

  it('🔴 들어갈 자리가 없으면 제안하지 않는다', () => {
    // 옮길 날이 하루 종일 차 있으면 어디에 넣어도 겹친다. 억지로 넣느니 안 내는 게 낫다
    const target = item({ day: 1, start: '12:00', end: '13:00',
                          rest: '매주 화요일', use: '09:00~21:00' });
    const packed = item({ day: 2, start: '09:00', end: '20:59' });
    expect(proposeLocalPatches({
      finding: finding({ targetItemId: target.id }),
      items: [target, packed], holidays: KOREAN_HOLIDAYS,
    })).toHaveLength(0);
  });

  it('옮길 날도 휴무면 제안하지 않는다', () => {
    // 목·금 둘 다 휴무라 갈 날이 없다
    const target = item({ day: 2, rest: '매주 목요일, 금요일', use: '09:00~18:00' });
    const other = item({ day: 1 });
    expect(proposeLocalPatches({
      finding: finding({ targetItemId: target.id }), items: [target, other], holidays: KOREAN_HOLIDAYS,
    })).toHaveLength(0);
  });

  it('시각 충돌이면 순서 교체를 낸다 — 날짜는 무의미하다', () => {
    const target = item({ rest: '연중무휴', use: '09:00~18:00', label: 'A' });
    const sameDay = item({ rest: '연중무휴', use: '09:00~18:00', label: 'B' });
    const [p] = proposeLocalPatches({
      finding: finding({ targetItemId: target.id, reasonCode: 'OPEN_HOUR_CONFLICT' }),
      items: [target, sameDay], holidays: KOREAN_HOLIDAYS,
    });
    expect(p).toMatchObject({ type: 'REORDER' });
    expect((p?.payload as { swapWithItemId: number }).swapWithItemId).toBe(sameDay.id);
  });
});

describe('R02 — 해당 일정 제거 (FR-RU-022②)', () => {
  it('끝난 행사는 빼는 수정안을 낸다', () => {
    const target = item({ label: '경포벚꽃축제' });
    const [p] = proposeLocalPatches({
      finding: finding({ ruleCode: 'R02', reasonCode: 'EVENT_ENDED', targetItemId: target.id }),
      items: [target], holidays: KOREAN_HOLIDAYS,
    });
    expect(p).toMatchObject({ type: 'REMOVE_ITEM', targetItemId: target.id, payload: {} });
  });
});

describe('R03 — 뒤를 미루거나 앞을 줄인다 (FR-RU-033)', () => {
  it('두 가지를 다 제시한다', () => {
    const a = item({ start: '12:00', end: '13:00', label: '가람집' });
    const b = item({ start: '12:30', end: '14:00', label: '오죽헌' });
    const patches = proposeLocalPatches({
      finding: finding({ ruleCode: 'R03', reasonCode: 'TIME_OVERLAP', targetItemId: a.id, targetItemId2: b.id }),
      items: [a, b], holidays: KOREAN_HOLIDAYS,
    });
    expect(patches).toHaveLength(2);
    // ① 뒤 일정을 겹친 30분만큼 민다
    expect(patches[0]).toMatchObject({ type: 'TIME_SHIFT', targetItemId: b.id });
    expect(patches[0]?.payload).toEqual({ newStartTime: '13:00', newEndTime: '14:30' });
    // ② 앞 일정을 뒤 시작까지로 줄인다
    expect(patches[1]?.payload).toEqual({ newEndTime: '12:30' });
  });

  it('겹치지 않으면 제안하지 않는다', () => {
    const a = item({ start: '12:00', end: '13:00' });
    const b = item({ start: '13:00', end: '14:00' });
    expect(proposeLocalPatches({
      finding: finding({ ruleCode: 'R03', targetItemId: a.id, targetItemId2: b.id }),
      items: [a, b], holidays: KOREAN_HOLIDAYS,
    })).toHaveLength(0);
  });
});

describe('R07 — 공백에 식사를 넣는다 (FR-RU-073)', () => {
  it('가장 긴 공백을 고른다', () => {
    const a = item({ start: '09:00', end: '10:00' });
    const b = item({ start: '10:30', end: '11:00' });
    const c = item({ start: '15:00', end: '18:00' });
    const [p] = proposeLocalPatches({
      finding: finding({ ruleCode: 'R07', reasonCode: 'MEAL_REST_MISSING', targetItemId: a.id, evidence: { dayNo: 1 } }),
      items: [a, b, c], holidays: KOREAN_HOLIDAYS,
    });
    // 11:00~15:00 이 가장 길다
    expect(p).toMatchObject({ type: 'INSERT_ITEM' });
    expect(p?.payload).toMatchObject({ dayNo: 1, afterItemId: b.id, startTime: '11:00', endTime: '12:00', itemType: 'MEAL' });
  });

  it('공백이 최소 식사 시간보다 짧으면 제안하지 않는다', () => {
    // 넣자마자 R03 시간 중복이 날 수정안을 낼 수는 없다
    const a = item({ start: '09:00', end: '10:00' });
    const b = item({ start: '10:30', end: '18:00' });
    expect(proposeLocalPatches({
      finding: finding({ ruleCode: 'R07', targetItemId: a.id, evidence: { dayNo: 1 } }),
      items: [a, b], holidays: KOREAN_HOLIDAYS,
    })).toHaveLength(0);
  });
});

describe('대체 후보 정렬 (FR-PA-003)', () => {
  const target = item({ contentId: '999' });
  const raw = (id: string, type: string, dist: string, l2 = 'AA01'): Record<string, unknown> =>
    ({ contentid: id, contenttypeid: type, dist, mapx: '128.9', mapy: '37.8', lclsSystm2: l2 });

  it('① 같은 유형이 먼저다', () => {
    const ranked = rankCandidates([raw('1', '39', '100'), raw('2', '12', '900')], target, new Map());
    expect(ranked[0]?.ktoContentId).toBe('2');
  });

  it('② 같은 유형끼리는 가까운 순이다', () => {
    const ranked = rankCandidates([raw('1', '12', '900'), raw('2', '12', '100')], target, new Map());
    expect(ranked.map((c) => c.ktoContentId)).toEqual(['2', '1']);
  });

  it('③ 거리가 같으면 해석이 확정된 것이 먼저다', () => {
    const known = new Map([['1', 'CONFIRMED' as const]]);
    const ranked = rankCandidates([raw('2', '12', '100'), raw('1', '12', '100')], target, known);
    expect(ranked[0]?.ktoContentId).toBe('1');
  });

  it('자기 자신은 후보에서 뺀다', () => {
    const ranked = rankCandidates([raw('999', '12', '0'), raw('1', '12', '100')], target, new Map());
    expect(ranked.map((c) => c.ktoContentId)).toEqual(['1']);
  });

  it('중복 contentid 를 한 번만 담는다', () => {
    const ranked = rankCandidates([raw('1', '12', '100'), raw('1', '12', '200')], target, new Map());
    expect(ranked).toHaveLength(1);
  });

  it('평점 정렬을 쓰지 않는다 — 공사 데이터에 평점이 없다', () => {
    const ranked = rankCandidates([raw('1', '12', '100')], target, new Map());
    expect(Object.keys(ranked[0] ?? {})).not.toContain('rating');
  });

  it('동률에서 순서가 흔들리지 않는다 (NF-MT-001)', () => {
    const rows = [raw('b', '12', '100'), raw('a', '12', '100')];
    expect(rankCandidates(rows, target, new Map())).toEqual(rankCandidates([...rows].reverse(), target, new Map()));
  });
});

describe('대체 관광지 탐색', () => {
  const kto = (): ReturnType<typeof createKtoClient> => createKtoClient(new InMemoryApiCallLogger(), FIXTURE_ENV);

  it('좌표가 없으면 찾지 않는다 — 엉뚱한 지역을 제안하느니 없는 편이 낫다', async () => {
    const target = item({ mapX: null, mapY: null });
    expect(await proposeReplacements(target, { kto: kto() })).toHaveLength(0);
  });

  it('반경 상한 20km 를 넘기지 않는다', async () => {
    const logger = new InMemoryApiCallLogger();
    await proposeReplacements(item(), { kto: createKtoClient(logger, FIXTURE_ENV), radiusMeters: 999_999 });
    // 상한을 넘겼다면 어댑터가 던졌을 것이다 (EI-KT-008)
    expect(logger.entries.every((e) => e.status === 'OK')).toBe(true);
  });

  it('조회에 실패해도 검수를 세우지 않는다', async () => {
    const target = item({ mapX: 0, mapY: 0 });
    await expect(proposeReplacements(target, { kto: kto() })).resolves.toBeDefined();
  });

  it('finding 당 3개를 넘지 않는다 (FR-PA-002)', async () => {
    const patches = await proposeReplacements(item(), { kto: kto() });
    expect(patches.length).toBeLessThanOrEqual(MAX_PATCHES_PER_FINDING);
  });
});

describe('R08 — 이동시간 부족 (FR-RU-083)', () => {
  const r08 = (over: Partial<Finding> = {}): Finding => finding({
    ruleCode: 'R08', severity: 'ERROR', reasonCode: 'TRAVEL_TIME_SHORT',
    evidence: { shortfallMinutes: 13 }, requiresExternal: true, ...over,
  });

  it('① 뒤 일정을 부족한 만큼 뒤로 민다', () => {
    const from = item({ start: '12:30', end: '15:00', label: '오죽헌' });
    const to = item({ start: '15:00', end: '16:00', label: '농산물도매시장' });
    const patches = proposeLocalPatches({
      finding: r08({ targetItemId: from.id, targetItemId2: to.id }),
      items: [from, to], holidays: KOREAN_HOLIDAYS,
    });

    expect(patches[0]).toMatchObject({ type: 'TIME_SHIFT', targetItemId: to.id });
    expect(patches[0]?.payload).toEqual({ newStartTime: '15:13', newEndTime: '16:13' });
  });

  it('🔴 부족분을 모르면 아무것도 내지 않는다', () => {
    // 얼마나 밀어야 하는지 모르는 채로 시간을 옮기면 그만큼 또 모자란다
    const from = item({ start: '12:30', end: '15:00' });
    const to = item({ start: '15:00', end: '16:00' });
    for (const bad of [undefined, 0, -5, 'x']) {
      expect(proposeLocalPatches({
        finding: r08({ targetItemId: from.id, targetItemId2: to.id, evidence: { shortfallMinutes: bad } }),
        items: [from, to], holidays: KOREAN_HOLIDAYS,
      }), String(bad)).toHaveLength(0);
    }
  });

  it('② 바꿔 놓으면 더 가까워지는 항목만 낸다', () => {
    // 경포대(from) 기준 — 오죽헌이 훨씬 가깝다
    const from = item({ mapX: 128.8961, mapY: 37.7955, label: '경포대' });
    const far = item({ start: '15:00', end: '16:00', mapX: 129.05, mapY: 37.55, label: '먼 곳' });
    const near = item({ start: '17:00', end: '18:00', mapX: 128.8779, mapY: 37.7793, label: '오죽헌' });

    const patches = proposeLocalPatches({
      finding: r08({ targetItemId: from.id, targetItemId2: far.id }),
      items: [from, far, near], holidays: KOREAN_HOLIDAYS,
    });
    expect(patches).toContainEqual(expect.objectContaining({
      type: 'REORDER', targetItemId: far.id, payload: { swapWithItemId: near.id },
    }));
  });

  it('🔴 더 멀어지는 교체는 내지 않는다', () => {
    // 순서를 바꿔 봤자 더 멀어지는 제안은 낼 수 없다
    const from = item({ mapX: 128.8961, mapY: 37.7955 });
    const near = item({ start: '15:00', end: '16:00', mapX: 128.8779, mapY: 37.7793 });
    const far = item({ start: '17:00', end: '18:00', mapX: 129.05, mapY: 37.55 });

    const patches = proposeLocalPatches({
      finding: r08({ targetItemId: from.id, targetItemId2: near.id }),
      items: [from, near, far], holidays: KOREAN_HOLIDAYS,
    });
    expect(patches.filter((p) => p.type === 'REORDER')).toHaveLength(0);
  });

  it('🔴 좌표를 모르면 순서 교체를 내지 않는다', () => {
    // 0 으로 치면 적도 앞바다가 기준이 되어 아무거나 「가깝다」가 된다
    const from = item({ mapX: null, mapY: null });
    const to = item({ start: '15:00', end: '16:00' });
    const other = item({ start: '17:00', end: '18:00' });
    const patches = proposeLocalPatches({
      finding: r08({ targetItemId: from.id, targetItemId2: to.id }),
      items: [from, to, other], holidays: KOREAN_HOLIDAYS,
    });
    expect(patches.filter((p) => p.type === 'REORDER')).toHaveLength(0);
  });

  it('🔴 ③ 대체 후보는 앞 항목 주변에서 찾는다', async () => {
    /*
     * 너무 먼 것이 문제인데 그 자리에서 찾으면 여전히 먼 것들만 나온다. 앞 항목을 중심으로
     * 찾아야 실제로 가까워진다 (FR-RU-083 ③).
     */
    const origin = { x: 128.898632, y: 37.753996 };
    const far = item({ mapX: 129.2, mapY: 37.2, rest: '연중무휴', use: '09:00~18:00' });
    const patches = await proposeReplacements(far, {
      kto: createKtoClient(new InMemoryApiCallLogger(), FIXTURE_ENV),
      center: origin,
    });
    expect(patches.length).toBeGreaterThan(0);
    // 픽스처는 앞 항목 좌표 기준 위치기반 목록이다 — 그 후보들이 나와야 한다
    for (const p of patches) {
      expect(String((p.payload as { ktoContentId: string }).ktoContentId)).toMatch(/^\d+$/);
    }
  });
});

describe('R04 — 반복 유형 (FR-RU-043)', () => {
  const r04 = (itemIds: unknown): Finding => finding({
    ruleCode: 'R04', severity: 'WARNING', reasonCode: 'CONTENT_IMBALANCE',
    targetItemId: null, evidence: { itemIds, axis: 'lclsSystm2', key: 'VE07', count: 3 },
  });

  it('반복된 것 중 마지막 하나를 뺀다', () => {
    const a = item({ day: 1, start: '10:00', end: '11:00' });
    const b = item({ day: 1, start: '13:00', end: '14:00' });
    const c = item({ day: 2, start: '10:00', end: '11:00' });
    const patches = proposeLocalPatches({
      finding: r04([a.id, b.id, c.id]), items: [a, b, c], holidays: KOREAN_HOLIDAYS,
    });
    expect(patches).toEqual([{ patchId: 'p-1', type: 'REMOVE_ITEM', targetItemId: c.id, payload: {} }]);
  });

  it('🔴 대상 항목이 없어도 진입한다 — 상품 단위 판정이다', () => {
    /*
     * R04 · R09 · R10 은 `targetItemId` 가 null 이다. 대상 항목을 먼저 찾고 없으면 돌아가던
     * 구조라 이 셋은 수정안이 하나도 안 나왔다.
     */
    const a = item(); const b = item();
    expect(r04([a.id, b.id]).targetItemId).toBeNull();
    expect(proposeLocalPatches({ finding: r04([a.id, b.id]), items: [a, b], holidays: KOREAN_HOLIDAYS }))
      .toHaveLength(1);
  });

  it('🔴 순서가 흔들리지 않는다 (NF-MT-001)', () => {
    // 같은 검수가 실행마다 다른 항목을 빼면 안 된다
    const a = item({ day: 1, start: '10:00', end: '11:00' });
    const b = item({ day: 2, start: '09:00', end: '10:00' });
    const forward = proposeLocalPatches({ finding: r04([a.id, b.id]), items: [a, b], holidays: KOREAN_HOLIDAYS });
    const backward = proposeLocalPatches({ finding: r04([b.id, a.id]), items: [b, a], holidays: KOREAN_HOLIDAYS });
    expect(forward).toEqual(backward);
    expect(lastRepeated(r04([b.id, a.id]), [a, b])?.id).toBe(b.id);
  });

  it('🔴 근거가 없으면 아무것도 안 낸다', () => {
    const a = item();
    for (const bad of [undefined, [], [a.id], 'x']) {
      expect(proposeLocalPatches({ finding: r04(bad), items: [a], holidays: KOREAN_HOLIDAYS }), String(bad))
        .toHaveLength(0);
    }
  });
});

describe('R09 — 실내·야외 순서 교체 (FR-RU-093 ②)', () => {
  const MAP = { VE07: 'INDOOR', LS01: 'OUTDOOR' } as const;
  const r09 = (date = '2026-10-22'): Finding => finding({
    ruleCode: 'R09', severity: 'WARNING', reasonCode: 'RAIN_RISK',
    targetItemId: null, evidence: { date, outdoorRatio: 0.8 }, requiresExternal: true,
  });

  const withLcls = (base: AuditItem, lcls2: string): AuditItem => ({ ...base, lclsSystm2: lcls2 });

  it('앞쪽 실내와 뒤쪽 야외를 바꾼다', () => {
    const indoor = withLcls(item({ start: '10:00', end: '11:00' }), 'VE07');
    const outdoor = withLcls(item({ start: '14:00', end: '15:00' }), 'LS01');
    const patches = proposeLocalPatches({
      finding: r09(indoor.date), items: [indoor, outdoor], holidays: KOREAN_HOLIDAYS, indoorOutdoor: MAP,
    });
    expect(patches).toEqual([{
      patchId: 'p-1', type: 'REORDER', targetItemId: indoor.id, payload: { swapWithItemId: outdoor.id },
    }]);
  });

  it('🔴 이미 실내가 뒤면 바꾸지 않는다', () => {
    // 바꿔 봤자 더 나빠진다
    const outdoor = withLcls(item({ start: '10:00', end: '11:00' }), 'LS01');
    const indoor = withLcls(item({ start: '14:00', end: '15:00' }), 'VE07');
    expect(proposeLocalPatches({
      finding: r09(outdoor.date), items: [outdoor, indoor], holidays: KOREAN_HOLIDAYS, indoorOutdoor: MAP,
    })).toHaveLength(0);
  });

  it('🔴 구분을 모르는 중분류는 건드리지 않는다', () => {
    /*
     * 실내인지 야외인지 모르는 것을 옮기면 더 나빠질 수도 있다 (FR-RU-051). 모르는 것을
     * 야외로 쳐 버리면 **실내를 그 뒤로 보내는** 엉뚱한 제안이 나간다.
     */
    const indoor = withLcls(item({ start: '10:00', end: '11:00' }), 'VE07');
    const unknown = withLcls(item({ start: '14:00', end: '15:00' }), 'ZZ99');
    expect(proposeLocalPatches({
      finding: r09(indoor.date), items: [indoor, unknown], holidays: KOREAN_HOLIDAYS, indoorOutdoor: MAP,
    })).toHaveLength(0);

    // 둘 다 모르는 경우도 마찬가지다
    const a = withLcls(item({ start: '10:00', end: '11:00' }), 'ZZ98');
    const b = withLcls(item({ start: '14:00', end: '15:00' }), 'ZZ97');
    expect(proposeLocalPatches({
      finding: r09(a.date), items: [a, b], holidays: KOREAN_HOLIDAYS, indoorOutdoor: MAP,
    })).toHaveLength(0);
  });

  it('🔴 다른 날 항목은 섞지 않는다', () => {
    const indoor = withLcls(item({ day: 1, start: '10:00', end: '11:00' }), 'VE07');
    const outdoor = withLcls(item({ day: 2, start: '14:00', end: '15:00' }), 'LS01');
    expect(proposeLocalPatches({
      finding: r09(indoor.date), items: [indoor, outdoor], holidays: KOREAN_HOLIDAYS, indoorOutdoor: MAP,
    })).toHaveLength(0);
  });
});

describe('넣을 자리 계산 (R09 ① · R10 · FR-RU-103)', () => {
  const r10 = (missing: unknown): Finding => finding({
    ruleCode: 'R10', severity: 'WARNING', reasonCode: 'TARGET_MISMATCH',
    targetItemId: null, evidence: { missingLcls2: missing },
  });

  it('가장 넉넉한 빈 구간에 앞뒤 여유를 두고 자리를 잡는다', () => {
    const a = item({ start: '10:00', end: '11:00' });
    const b = item({ start: '16:00', end: '17:00' });
    const plan = planInsertion(r10(['VE07']), [a, b], {}, 90);

    expect(plan?.slot.afterItemId).toBe(a.id);
    expect(plan?.slot.startTime).toBe('11:30');
    expect(plan?.slot.endTime).toBe('13:00');
    expect(plan?.wantLcls2).toEqual(['VE07']);
  });

  it('🔴 결손 유형을 모르면 자리를 잡지 않는다', () => {
    // 무엇을 넣을지 모르는 채로 자리만 비워 두면 제안이 아니다 (FR-RU-051)
    const a = item({ start: '10:00', end: '11:00' });
    const b = item({ start: '16:00', end: '17:00' });
    for (const bad of [undefined, [], 'x']) {
      expect(planInsertion(r10(bad), [a, b], {}, 90), String(bad)).toBeNull();
    }
  });

  it('🔴 소요시간은 되는데 여유가 모자라면 잡지 않는다', () => {
    /*
     * 앞뒤 여유까지 들어가야 자리다. 소요시간만 보고 끼우면 앞뒤 항목에 맞붙어, 반영 후
     * 재검수에서 「이동에 N분이 걸리는데 배정된 시간은 0분」 오류가 난다 (R08).
     */
    const a = item({ start: '10:00', end: '11:00' });
    // 120분 틈. 소요 90분은 들어가지만 앞뒤 30분씩(총 150분)은 못 들어간다
    const tight = item({ start: '13:00', end: '14:00' });
    expect(planInsertion(r10(['VE07']), [a, tight], {}, 90)).toBeNull();

    const roomy = item({ start: '14:00', end: '15:00' });
    expect(planInsertion(r10(['VE07']), [a, roomy], {}, 90)).not.toBeNull();
  });

  it('🔴 R09 는 그 날 안에서만, 실내 중분류만 채운다', () => {
    const a = item({ day: 1, start: '10:00', end: '11:00' });
    const b = item({ day: 1, start: '16:00', end: '17:00' });
    const other = item({ day: 2, start: '10:00', end: '11:00' });
    const r09 = finding({
      ruleCode: 'R09', reasonCode: 'RAIN_RISK', targetItemId: null,
      evidence: { date: a.date }, requiresExternal: true,
    });
    const plan = planInsertion(r09, [a, b, other], { VE07: 'INDOOR', LS01: 'OUTDOOR' }, 90);
    expect(plan?.wantLcls2).toEqual(['VE07']);
    expect(plan?.slot.dayNo).toBe(1);
  });
});
