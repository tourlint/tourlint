import { describe, expect, it } from 'vitest';
import { KOREAN_HOLIDAYS } from '../calendar/holidays';
import { R08TravelTimeRule, allowedMinutes, segmentKey, segmentsOf, type TravelSegment } from './r08-travel';
import { DEFAULT_AUDIT_SETTINGS } from './types';
import type { AuditItem, Finding } from './types';

const rule = new R08TravelTimeRule();

let nextId = 1;
interface Spec {
  readonly day?: number; readonly seq?: number;
  readonly start: string; readonly end?: string | null;
  readonly label?: string; readonly x?: number | null; readonly y?: number | null;
}
function item(s: Spec): AuditItem {
  return {
    id: nextId++, dayNo: s.day ?? 1, seq: s.seq ?? nextId, date: '2026-10-22',
    startTime: s.start, endTime: s.end === undefined ? null : s.end,
    endTimeSource: 'INPUT', lclsSystm1: null, lclsSystm2: null, lclsSystm3: null,
    mapX: s.x === undefined ? 128.8961 : s.x, mapY: s.y === undefined ? 37.7952 : s.y,
    itemType: 'SIGHT', placeLabel: s.label ?? '장소', matchStatus: 'CONFIRMED', content: null,
  };
}

function evaluate(items: readonly AuditItem[], travel: Record<string, TravelSegment>): readonly Finding[] {
  return rule.evaluate({
    productId: 1, items, holidays: KOREAN_HOLIDAYS, settings: DEFAULT_AUDIT_SETTINGS,
    travelTimes: new Map(Object.entries(travel)),
  });
}

const ok = (minutes: number, futureBased = true): TravelSegment =>
  ({ ok: true, durationSeconds: minutes * 60, distanceMeters: minutes * 800, futureBased });

describe('segmentsOf — 연속한 두 항목이 호출 단위다 (EI-KM-006)', () => {
  it('8곳이면 7구간이다', () => {
    const items = Array.from({ length: 8 }, (_, i) => item({ seq: i + 1, start: '10:00', end: '11:00' }));
    expect(segmentsOf(items)).toHaveLength(7);
  });

  it('일차를 넘어가는 구간은 만들지 않는다', () => {
    const items = [
      item({ day: 1, seq: 1, start: '10:00', end: '11:00' }),
      item({ day: 1, seq: 2, start: '12:00', end: '13:00' }),
      item({ day: 2, seq: 1, start: '10:00', end: '11:00' }),
    ];
    expect(segmentsOf(items)).toHaveLength(1);
  });

  it('seq 로 순서를 고정한다 — 입력 순서와 무관하다 (NF-MT-001)', () => {
    const a = item({ seq: 1, start: '10:00', end: '11:00', label: 'A' });
    const b = item({ seq: 2, start: '12:00', end: '13:00', label: 'B' });
    expect(segmentsOf([b, a])[0]?.from.placeLabel).toBe('A');
  });
});

describe('배정 이동 가능 시간', () => {
  it('앞 종료부터 뒤 시작까지다', () => {
    expect(allowedMinutes(item({ start: '10:00', end: '11:00' }), item({ start: '11:30' }))).toBe(30);
  });

  it('앞 항목에 종료시간이 없으면 계산하지 않는다', () => {
    expect(allowedMinutes(item({ start: '10:00', end: null }), item({ start: '11:30' }))).toBeNull();
  });
});

describe('R08 — 버퍼 0분 (FR-RU-081)', () => {
  const pair = (): [AuditItem, AuditItem] => [
    item({ seq: 1, start: '10:00', end: '11:00', label: '경포대' }),
    item({ seq: 2, start: '11:30', label: '오죽헌' }),
  ];

  it('배정 30분에 30분이 걸리면 통과한다 — 경계는 포함이다', () => {
    const [a, b] = pair();
    expect(evaluate([a, b], { [segmentKey(a.id, b.id)]: ok(30) })).toHaveLength(0);
  });

  it('31분이 걸리면 오류다', () => {
    const [a, b] = pair();
    const [f] = evaluate([a, b], { [segmentKey(a.id, b.id)]: ok(31) });
    expect(f).toMatchObject({ severity: 'ERROR', reasonCode: 'TRAVEL_TIME_SHORT', targetItemId: a.id, targetItemId2: b.id });
    // 부족 분을 메시지에 명시한다
    expect(f?.message).toContain('1분이 모자랍니다');
    expect(f?.evidence).toMatchObject({ allowedMinutes: 30, neededMinutes: 31, shortfallMinutes: 1, bufferMinutes: 0 });
  });

  it('초는 올림한다 — 30분 1초는 31분이다', () => {
    const [a, b] = pair();
    const seg: TravelSegment = { ok: true, durationSeconds: 30 * 60 + 1, distanceMeters: 1000, futureBased: true };
    expect(evaluate([a, b], { [segmentKey(a.id, b.id)]: seg })).toHaveLength(1);
  });

  it('외부 참고 배지와 제공자명을 단다 (FR-RU-082)', () => {
    const [a, b] = pair();
    const [f] = evaluate([a, b], { [segmentKey(a.id, b.id)]: ok(60) });
    expect(f).toMatchObject({ requiresExternal: true, externalSource: '카카오모빌리티' });
    expect(rule.requiresExternal).toBe(true);
  });

  it('현재 시각 기준으로 산출했으면 그 사실을 표기한다 (FR-RU-085)', () => {
    const [a, b] = pair();
    const [f] = evaluate([a, b], { [segmentKey(a.id, b.id)]: ok(60, false) });
    expect(f?.message).toContain('현재 시각 기준');
    expect(f?.evidence.futureBased).toBe(false);
  });
});

describe('조회하지 못한 구간은 확인 불가다 (EI-KM-009)', () => {
  const [a, b] = [item({ seq: 1, start: '10:00', end: '11:00', label: '경포대' }), item({ seq: 2, start: '11:30', label: '오죽헌' })];

  it('대중교통은 판정하지 않고 직접 확인을 안내한다 (FR-RU-086)', () => {
    // 자동차 시간을 대중교통 시간으로 대체해 제시하지 않는다
    const [f] = evaluate([a, b], { [segmentKey(a.id, b.id)]: { ok: false, reasonCode: 'TRANSIT_NOT_SUPPORTED' } });
    expect(f).toMatchObject({ severity: 'UNVERIFIED', reasonCode: 'TRANSIT_NOT_SUPPORTED', needsConfirmation: true });
    expect(f?.message).toContain('대중교통');
    // 외부를 부르지 않았으므로 참고 배지를 달지 않는다
    expect(f?.requiresExternal).toBe(false);
  });

  it.each(['ROUTE_NOT_FOUND', 'ROUTE_PROVIDER_FAILED', 'COORD_MISSING'] as const)('%s 도 확인 불가다', (reasonCode) => {
    const [f] = evaluate([a, b], { [segmentKey(a.id, b.id)]: { ok: false, reasonCode } });
    expect(f).toMatchObject({ severity: 'UNVERIFIED', reasonCode, needsConfirmation: true });
  });

  it('산출값이 없는 구간은 아무것도 하지 않는다', () => {
    expect(evaluate([a, b], {})).toHaveLength(0);
  });
});

describe('결정론성 (NF-MT-001)', () => {
  it('같은 입력이면 같은 판정이다', () => {
    const [a, b] = [item({ seq: 1, start: '10:00', end: '11:00' }), item({ seq: 2, start: '11:10' })];
    const travel = { [segmentKey(a.id, b.id)]: ok(30) };
    const runs = Array.from({ length: 3 }, () => evaluate([a, b], travel));
    for (const r of runs) expect(r).toEqual(runs[0]);
  });

  it('규칙 메타는 계약이다', () => {
    expect(rule.code).toBe('R08');
    expect(rule.defaultSeverity).toBe('ERROR');
  });
});
