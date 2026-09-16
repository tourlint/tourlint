import { describe, expect, it } from 'vitest';
import { validateCompanyUpdate } from './settings.dto';
import { computeCompanyUpdate, COMPANY_SETTING_DEFAULTS } from './settings.repository';

describe('validateCompanyUpdate — 회사 기준은 표준보다 엄격하게만 (FR-OP-022)', () => {
  it('연속 일정 7시간은 느슨해서 거부한다 (표준 6)', () => {
    const r = validateCompanyUpdate({ r07SpanHours: 7 });
    expect(r.notStricter).toBe(true);
    expect(r.patch.r07SpanHours).toBeUndefined();
  });

  it('연속 일정 5시간은 허용한다', () => {
    const r = validateCompanyUpdate({ r07SpanHours: 5 });
    expect(r.notStricter).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.patch.r07SpanHours).toBe(5);
  });

  it('식사 30분은 느슨해서 거부한다 (표준 60)', () => {
    const r = validateCompanyUpdate({ r07MealMinutes: 30 });
    expect(r.notStricter).toBe(true);
    expect(r.patch.r07MealMinutes).toBeUndefined();
  });

  it('식사 90분은 허용한다', () => {
    const r = validateCompanyUpdate({ r07MealMinutes: 90 });
    expect(r.notStricter).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.patch.r07MealMinutes).toBe(90);
  });

  it('표준과 같은 값(6시간 · 60분)은 허용한다 — 엄격하게만이지 반드시 더 엄격은 아니다', () => {
    const r = validateCompanyUpdate({ r07SpanHours: 6, r07MealMinutes: 60 });
    expect(r.notStricter).toBe(false);
    expect(r.patch).toEqual({ r07SpanHours: 6, r07MealMinutes: 60 });
  });

  it('관심 키워드는 공백 제거 · 중복 제거로 받는다', () => {
    const r = validateCompanyUpdate({ watchKeywords: [' 온천 ', '온천', ''] });
    expect(r.patch.watchKeywords).toEqual(['온천']);
  });

  it('관심 지역은 {regnCd, signguCd|null, month} 모양만 받고 세종은 signguCd null', () => {
    const r = validateCompanyUpdate({
      watchRegions: [
        { regnCd: '51', signguCd: '150', month: '2026-10' },
        { regnCd: '36110', signguCd: null, month: '2026-11' },
      ],
    });
    expect(r.errors).toEqual([]);
    expect(r.patch.watchRegions).toHaveLength(2);
    expect(r.patch.watchRegions?.[1]).toEqual({ regnCd: '36110', signguCd: null, month: '2026-11' });
  });

  it('월 형식이 틀린 관심 지역은 거부한다', () => {
    const r = validateCompanyUpdate({ watchRegions: [{ regnCd: '51', signguCd: '150', month: '2026/10' }] });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.patch.watchRegions).toBeUndefined();
  });
});

describe('computeCompanyUpdate — 바뀐 R07 값만 이력에 남긴다 (FR-OP-026)', () => {
  it('바꾼 두 값이 각각 이력 한 줄로 쌓이고 updatedAt 이 찍힌다', () => {
    const next = computeCompanyUpdate(
      COMPANY_SETTING_DEFAULTS,
      { r07SpanHours: 5, r07MealMinutes: 90 },
      '2026-09-16T02:00:00.000Z',
    );
    expect(next.history).toEqual([
      { at: '2026-09-16T02:00:00.000Z', field: 'r07SpanHours', from: 6, to: 5 },
      { at: '2026-09-16T02:00:00.000Z', field: 'r07MealMinutes', from: 60, to: 90 },
    ]);
    expect(next.updatedAt).toBe('2026-09-16T02:00:00.000Z');
  });

  it('값이 그대로면 이력에 남기지 않는다', () => {
    const base = { ...COMPANY_SETTING_DEFAULTS, r07SpanHours: 5, history: [] };
    const next = computeCompanyUpdate(base, { r07SpanHours: 5, watchKeywords: ['온천'] }, '2026-09-16T03:00:00.000Z');
    expect(next.history).toEqual([]);
    expect(next.watchKeywords).toEqual(['온천']);
  });

  it('이력은 최근 50개만 남긴다', () => {
    const history = Array.from({ length: 50 }, (_, i) => ({
      at: `2026-09-16T00:00:${String(i).padStart(2, '0')}.000Z`,
      field: 'r07SpanHours' as const,
      from: 6,
      to: 5,
    }));
    const next = computeCompanyUpdate(
      { ...COMPANY_SETTING_DEFAULTS, r07MealMinutes: 60, history },
      { r07MealMinutes: 90 },
      '2026-09-16T04:00:00.000Z',
    );
    expect(next.history).toHaveLength(50);
    expect(next.history.at(-1)).toEqual({ at: '2026-09-16T04:00:00.000Z', field: 'r07MealMinutes', from: 60, to: 90 });
  });
});
