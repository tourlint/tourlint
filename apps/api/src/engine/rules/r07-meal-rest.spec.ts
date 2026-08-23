import { describe, expect, it } from 'vitest';
import { KOREAN_HOLIDAYS } from '../calendar/holidays';
import { R07MealRestRule, daySpan, evaluateDay } from './r07-meal-rest';
import { DEFAULT_AUDIT_SETTINGS } from './types';
import type { AuditItem, Finding } from './types';

const rule = new R07MealRestRule();

type ItemType = AuditItem['itemType'];

interface Spec {
  readonly day?: number;
  readonly seq?: number;
  readonly start: string;
  readonly end?: string | null;
  readonly type?: ItemType;
  readonly label?: string;
}

let nextId = 1;
function item(s: Spec): AuditItem {
  return {
    id: nextId++, dayNo: s.day ?? 1, seq: s.seq ?? 1,
    date: '2026-10-22', startTime: s.start,
    endTime: s.end === undefined ? null : s.end,
    endTimeSource: 'INPUT', lclsSystm1: null, lclsSystm2: null, lclsSystm3: null, mapX: null, mapY: null,
    itemType: s.type ?? 'SIGHT', placeLabel: s.label ?? '장소',
    matchStatus: 'CONFIRMED', content: null,
  };
}

const evaluate = (items: readonly AuditItem[]): readonly Finding[] =>
  rule.evaluate({ productId: 1, items, holidays: KOREAN_HOLIDAYS, settings: DEFAULT_AUDIT_SETTINGS });

describe('daySpan — 연속 일정 시간', () => {
  it('첫 시작부터 마지막 종료까지다', () => {
    const span = daySpan([
      item({ start: '10:00', end: '11:30' }),
      item({ start: '12:00', end: '13:00' }),
      item({ start: '14:00', end: '15:00' }),
    ]);
    expect(span).toMatchObject({ from: '10:00', to: '15:00', minutes: 300 });
  });

  it('숙박은 **체크인 시각**이 끝점이다', () => {
    // 체크인은 그 날 일정의 끝이자 휴식의 시작이다. 종료시간도 없다 (FR-AU-011)
    const span = daySpan([
      item({ start: '10:00', end: '11:30' }),
      item({ start: '17:30', type: 'LODGING', label: '강릉강변스테이' }),
    ]);
    expect(span).toMatchObject({ from: '10:00', to: '17:30', minutes: 450 });
  });

  it('종료시간이 없는 항목은 시작 시각을 끝점으로 본다', () => {
    expect(daySpan([item({ start: '09:00' })])).toMatchObject({ minutes: 0 });
  });

  it('입력 순서가 달라도 같다', () => {
    const a = daySpan([item({ start: '10:00', end: '11:00' }), item({ start: '14:00', end: '15:00' })]);
    const b = daySpan([item({ start: '14:00', end: '15:00' }), item({ start: '10:00', end: '11:00' })]);
    expect(a).toEqual(b);
  });
});

describe('evaluateDay — 기준 시간 경계 (FR-RU-070)', () => {
  const withoutMeal = (from: string, to: string): AuditItem[] => [
    item({ start: from, end: to }),
  ];

  it('6시간 미만이면 판정하지 않는다', () => {
    // 5시간 59분
    expect(evaluateDay(withoutMeal('10:00', '15:59'), DEFAULT_AUDIT_SETTINGS)).toBe('SHORT_SPAN');
  });

  it('정확히 6시간이면 판정한다 — 경계는 포함이다', () => {
    expect(evaluateDay(withoutMeal('10:00', '16:00'), DEFAULT_AUDIT_SETTINGS)).toBe('MEAL_REST_MISSING');
  });

  it('설정값을 바꾸면 경계도 바뀐다 (FR-RU-072)', () => {
    const relaxed = { ...DEFAULT_AUDIT_SETTINGS, r07SpanHours: 8 };
    expect(evaluateDay(withoutMeal('10:00', '16:00'), relaxed)).toBe('SHORT_SPAN');
  });
});

describe('evaluateDay — 식사·휴식 (FR-RU-070 · 071)', () => {
  const longDay = (...extra: AuditItem[]): AuditItem[] => [
    item({ start: '10:00', end: '11:30' }),
    ...extra,
    item({ start: '16:00', end: '18:00' }),
  ];

  it('식사도 휴식도 없으면 MEAL_REST_MISSING', () => {
    expect(evaluateDay(longDay(), DEFAULT_AUDIT_SETTINGS)).toBe('MEAL_REST_MISSING');
  });

  it('60분 식사가 있으면 통과한다', () => {
    expect(evaluateDay(longDay(item({ start: '12:00', end: '13:00', type: 'MEAL' })), DEFAULT_AUDIT_SETTINGS)).toBe('OK');
  });

  it('59분이면 짧다 — 경계는 포함이다', () => {
    expect(evaluateDay(longDay(item({ start: '12:00', end: '12:59', type: 'MEAL' })), DEFAULT_AUDIT_SETTINGS))
      .toBe('MEAL_TIME_SHORT');
  });

  it('짧은 식사가 여럿이어도, 하나만 충분하면 통과한다', () => {
    expect(evaluateDay(longDay(
      item({ start: '12:00', end: '12:20', type: 'MEAL' }),
      item({ start: '13:00', end: '14:00', type: 'MEAL' }),
    ), DEFAULT_AUDIT_SETTINGS)).toBe('OK');
  });

  it('휴식 항목이 있으면 식사가 없어도 통과한다', () => {
    expect(evaluateDay(longDay(item({ start: '13:00', end: '14:00', type: 'REST' })), DEFAULT_AUDIT_SETTINGS)).toBe('OK');
  });

  it('종료시간이 없는 식사는 0분으로 본다 — 시간을 배정하지 않은 것이다', () => {
    expect(evaluateDay(longDay(item({ start: '12:00', type: 'MEAL' })), DEFAULT_AUDIT_SETTINGS)).toBe('MEAL_TIME_SHORT');
  });

  it('최소 식사 시간을 낮추면 통과한다 (FR-RU-072)', () => {
    const relaxed = { ...DEFAULT_AUDIT_SETTINGS, r07MealMinutes: 30 };
    expect(evaluateDay(longDay(item({ start: '12:00', end: '12:30', type: 'MEAL' })), relaxed)).toBe('OK');
  });
});

describe('R07 — 회귀 정답셋 재현', () => {
  it('TP-01 1일차 — 7.5시간이지만 식사 60분 확보로 미발동', () => {
    expect(evaluate([
      item({ day: 1, seq: 1, start: '10:00', end: '11:30', label: '경포대' }),
      item({ day: 1, seq: 2, start: '12:00', end: '13:00', type: 'MEAL', label: '가람집옹심이' }),
      item({ day: 1, seq: 3, start: '13:30', end: '15:00', label: '오죽헌' }),
      item({ day: 1, seq: 4, start: '15:30', end: '16:30', label: '농산물도매시장' }),
      item({ day: 1, seq: 5, start: '17:30', type: 'LODGING', label: '강릉강변스테이' }),
    ])).toHaveLength(0);
  });

  it('TP-01 3일차 — 5.5시간이라 기준 미만, 미발동', () => {
    expect(evaluate([
      item({ day: 3, seq: 1, start: '09:30', end: '10:30' }),
      item({ day: 3, seq: 2, start: '12:00', end: '13:00', type: 'MEAL' }),
      item({ day: 3, seq: 3, start: '14:00', end: '15:00' }),
    ])).toHaveLength(0);
  });

  it('TP-02 3일차 — 10:00~18:30 연속 8.5시간, 식사 0건 → MEAL_REST_MISSING', () => {
    const [f] = evaluate([
      item({ day: 3, seq: 1, start: '10:00', end: '11:00', label: '경포대' }),
      item({ day: 3, seq: 2, start: '17:30', end: '18:30', label: '농산물도매시장' }),
    ]);
    expect(f).toMatchObject({ severity: 'WARNING', reasonCode: 'MEAL_REST_MISSING', targetItemId: null });
    expect(f?.message).toContain('8.5시간');
    expect(f?.evidence.span).toMatchObject({ from: '10:00', to: '18:30', minutes: 510 });
  });

  it('TP-03 2일차 — 감천골 30분 < 60분 → MEAL_TIME_SHORT', () => {
    const meal = item({ day: 2, seq: 2, start: '12:00', end: '12:30', type: 'MEAL', label: '감천골' });
    const [f] = evaluate([
      item({ day: 2, seq: 1, start: '09:00', end: '10:00', label: '경포벚꽃축제' }),
      meal,
      item({ day: 2, seq: 3, start: '13:00', end: '14:00', label: '갈골한과체험전시관' }),
      item({ day: 2, seq: 4, start: '15:00', end: '16:00', label: '농산물도매시장' }),
    ]);
    expect(f).toMatchObject({ severity: 'WARNING', reasonCode: 'MEAL_TIME_SHORT' });
    // 고쳐야 할 항목을 지목한다
    expect(f?.targetItemId).toBe(meal.id);
    expect(f?.message).toContain('감천골');
    expect(f?.message).toContain('30분');
  });

  it('TP-03 1일차 — 9시간이지만 식사 60분 확보로 미발동', () => {
    expect(evaluate([
      item({ day: 1, seq: 1, start: '10:00', end: '11:30' }),
      item({ day: 1, seq: 2, start: '12:00', end: '13:00', type: 'MEAL' }),
      item({ day: 1, seq: 3, start: '12:30', end: '14:00' }),
      item({ day: 1, seq: 4, start: '19:00', type: 'LODGING' }),
    ])).toHaveLength(0);
  });
});

describe('R07 — 일차 단위 판정', () => {
  it('일차마다 따로 본다', () => {
    const found = evaluate([
      item({ day: 1, seq: 1, start: '10:00', end: '18:00' }),
      item({ day: 2, seq: 1, start: '10:00', end: '12:00' }),
      item({ day: 3, seq: 1, start: '09:00', end: '17:00' }),
    ]);
    expect(found.map((f) => f.evidence.dayNo)).toEqual([1, 3]);
  });

  it('일차 순서가 고정된다 — 입력 순서와 무관하다 (NF-MT-001)', () => {
    const a = evaluate([
      item({ day: 3, seq: 1, start: '09:00', end: '17:00' }),
      item({ day: 1, seq: 1, start: '10:00', end: '18:00' }),
    ]);
    expect(a.map((f) => f.evidence.dayNo)).toEqual([1, 3]);
  });

  it('규칙 메타는 계약이다', () => {
    expect(rule.code).toBe('R07');
    expect(rule.defaultSeverity).toBe('WARNING');
    // 일정표만 보면 판정된다. 외부 참고 배지가 붙으면 안 된다
    expect(rule.requiresExternal).toBe(false);
  });

  it('결정론성 (NF-MT-001)', () => {
    const items = [
      item({ day: 1, seq: 1, start: '09:00', end: '12:00' }),
      item({ day: 1, seq: 2, start: '12:00', end: '12:20', type: 'MEAL', label: '감천골' }),
      item({ day: 1, seq: 3, start: '13:00', end: '18:00' }),
    ];
    const runs = Array.from({ length: 3 }, () => evaluate(items));
    for (const r of runs) expect(r).toEqual(runs[0]);
  });
});
