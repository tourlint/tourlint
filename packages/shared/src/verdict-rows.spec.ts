import { describe, expect, it } from 'vitest';
import { verdictRows } from './verdict-rows';

/** 운영 run 70~73 에서 그대로 가져온 모양 (#478) */
const REAL = {
  R01: {
    date: '2026-11-17', step: 'OUT_OF_HOURS', verdict: 'CLOSED', dayOfWeek: 'TUE',
    confidence: 'CONFIRMED', needsConfirmation: false,
    hours: { open: '09:00', close: '18:00', breaks: [] },
    visit: { start: '17:30', end: '18:30' },
  },
  R02: {
    range: '2026-04-04 ~ 2026-04-11', verdict: 'ENDED', visitDate: '2026-11-18',
    eventPeriod: { start: '2026-04-04', end: '2026-04-11' }, needsConfirmation: false,
  },
  R03: {
    dayNo: 1, first: { start: '12:00', end: '13:00', itemId: 1 },
    second: { start: '12:30', end: '14:00', itemId: 2 },
    overlapMinutes: 30, needsConfirmation: false,
  },
  R07: {
    span: { from: '09:00', to: '16:00', minutes: 420 }, dayNo: 2,
    thresholds: { spanHours: 6, mealMinutes: 60 },
    mealMinutes: 30, restItemType: 'MEAL', needsConfirmation: false,
  },
  R10: {
    hasNight: true, targetKey: 'YOUTH_20S', conceptKey: 'EMOTIONAL', judgedCount: 8,
    lcls2Counts: { AC01: 1 }, lcls3Counts: { AC010100: 1 }, contentTypeCounts: { 12: 4 },
    expectsNight: true, missingLcls2: ['EX02', 'FD05'], expectedLcls2: ['EX02', 'FD05', 'VE01'],
    nightSlotFrom: '19:00', needsConfirmation: false,
  },
  /** 운영 run 75 — 비 올 확률이 높은 상품을 만들어 실제로 발동시킨 판정이다 (#502) */
  R09: {
    date: '2026-12-05', rainDays: 11.5, rainSource: 'CLIMATE', indoorCount: 1, mappedCount: 5,
    normalMonth: 12, outdoorRatio: 0.8, rainThreshold: 0.3, unmappedCount: 0,
    rainProbability: 0.371, needsConfirmation: false, outdoorRatioThreshold: 0.6,
  },
};

const valuesOf = (e: unknown): string[] => verdictRows(e).map((r) => r.value);
const labelsOf = (e: unknown): string[] => verdictRows(e).map((r) => r.label);

describe('판정 입력값을 사람 말로 (#478)', () => {
  it('🔴 어느 줄에도 [object Object] 가 없다 — 값이 안 보이던 자리다', () => {
    const leaked = Object.values(REAL)
      .flatMap((e) => verdictRows(e))
      .filter((r) => r.value.includes('[object'));
    expect(leaked).toEqual([]);
  });

  it('🔴 이름표와 값이 모두 한글이다 (R01)', () => {
    expect(verdictRows(REAL.R01)).toEqual([
      { label: '방문일', value: '2026-11-17' },
      { label: '판정', value: '휴무일' },
      { label: '요일', value: '화요일' },
      { label: '신뢰도', value: '확정' },
      { label: '운영시간', value: '09:00~18:00' },
      { label: '방문 시각', value: '17:30~18:30' },
    ]);
  });

  it('🔴 평년 경로도 전부 한글이다 (R09) — 조건부 스프레드 안이라 #480 에서 빠졌다', () => {
    expect(verdictRows(REAL.R09)).toEqual([
      { label: '방문일', value: '2026-12-05' },
      { label: '평년 강수일수', value: '11.5일' },
      { label: '예보 종류', value: '평년' },
      { label: '실내로 센 곳', value: '1곳' },
      { label: '실내 · 야외를 가린 곳', value: '5곳' },
      { label: '평년 기준 달', value: '12월' },
      { label: '야외 비중', value: '80%' },
      { label: '강수확률 기준', value: '30%' },
      { label: '실내 · 야외를 모르는 곳', value: '0곳' },
      { label: '강수확률', value: '37%' },
      { label: '야외 비중 기준', value: '60%' },
    ]);
  });

  it('객체는 한 줄로 편다', () => {
    expect(valuesOf(REAL.R03)).toContain('12:00~13:00');
    expect(valuesOf(REAL.R07)).toContain('09:00~16:00 · 420분');
    expect(valuesOf(REAL.R07)).toContain('연속 6시간 · 식사 60분');
  });

  it('분류 코드는 이름으로 (R10)', () => {
    expect(valuesOf(REAL.R10)).toContain('공예체험 · 카페/ 찻집');
    expect(valuesOf(REAL.R10)).toContain('20대');
    expect(valuesOf(REAL.R10)).toContain('감성');
  });

  it('🔴 내부 값은 빠진다 — 등급 배지와 판정 문장이 이미 말한다', () => {
    const all = Object.values(REAL).flatMap(labelsOf);
    for (const internal of ['needsConfirmation', 'step', 'lcls2Counts', 'eventPeriod']) {
      expect(all).not.toContain(internal);
    }
  });

  it('모르는 키는 키 이름 그대로 — 이름이 없다고 근거를 숨기지 않는다', () => {
    expect(verdictRows({ somethingNew: '값' })).toEqual([{ label: 'somethingNew', value: '값' }]);
  });

  it('뜻을 지어낼 수 없는 객체는 줄을 만들지 않는다', () => {
    expect(verdictRows({ unknownShape: { a: 1 } })).toEqual([]);
  });

  it('객체가 아니면 빈 목록이다', () => {
    expect(verdictRows(null)).toEqual([]);
    expect(verdictRows('CLOSED')).toEqual([]);
  });
});
