import { describe, expect, it } from 'vitest';
import { KOREAN_HOLIDAYS, SUPPORTED_YEARS } from './holidays';
import { parseIsoDate } from './dates';

const at = (iso: string): NonNullable<ReturnType<typeof parseIsoDate>> => {
  const d = parseIsoDate(iso);
  if (d === null) throw new Error(iso);
  return d;
};

describe('공휴일 표 (DR-NM-025)', () => {
  it('최소 2026 – 2027년을 포함한다', () => {
    for (const y of SUPPORTED_YEARS) expect(KOREAN_HOLIDAYS.isSupportedYear(y)).toBe(true);
  });

  it('표에 없는 연도는 "모른다" 고 답한다', () => {
    // 조용히 "공휴일 아님" 을 돌려주면 그 해 전체의 휴무 판정이 소리 없이 틀린다
    expect(KOREAN_HOLIDAYS.isSupportedYear(2030)).toBe(false);
  });

  it('설날 · 추석은 **당일만** 본다', () => {
    expect(KOREAN_HOLIDAYS.matches('LUNAR_NEW_YEAR', at('2026-02-17'))).toBe(true);
    expect(KOREAN_HOLIDAYS.matches('LUNAR_NEW_YEAR', at('2026-02-16'))).toBe(false);
    expect(KOREAN_HOLIDAYS.matches('CHUSEOK', at('2026-09-25'))).toBe(true);
    expect(KOREAN_HOLIDAYS.matches('CHUSEOK', at('2026-09-26'))).toBe(false);
  });

  it('연휴는 법정공휴일에는 든다', () => {
    expect(KOREAN_HOLIDAYS.matches('LEGAL_HOLIDAY', at('2026-02-16'))).toBe(true);
    expect(KOREAN_HOLIDAYS.matches('LEGAL_HOLIDAY', at('2026-09-26'))).toBe(true);
  });

  it('한글날은 법정공휴일이다 — 회귀 정답셋 기간에 든다', () => {
    expect(KOREAN_HOLIDAYS.matches('LEGAL_HOLIDAY', at('2026-10-09'))).toBe(true);
    expect(KOREAN_HOLIDAYS.nameOf(at('2026-10-09'))).toBe('한글날');
  });

  it('대체공휴일도 법정공휴일이다', () => {
    expect(KOREAN_HOLIDAYS.matches('LEGAL_HOLIDAY', at('2026-03-02'))).toBe(true);
    expect(KOREAN_HOLIDAYS.nameOf(at('2026-03-02'))).toBe('삼일절 대체공휴일');
  });

  it('평범한 날은 아무것도 아니다', () => {
    for (const rule of ['LUNAR_NEW_YEAR', 'CHUSEOK', 'LEGAL_HOLIDAY'] as const) {
      expect(KOREAN_HOLIDAYS.matches(rule, at('2026-10-08'))).toBe(false);
    }
    expect(KOREAN_HOLIDAYS.nameOf(at('2026-10-08'))).toBeNull();
  });

  it('공모전 시연 기간(2026-08 ~ 10)의 공휴일을 빠짐없이 담는다', () => {
    const inWindow = ['2026-08-15', '2026-08-17', '2026-09-24', '2026-09-25', '2026-09-26',
                      '2026-10-03', '2026-10-05', '2026-10-09'];
    for (const iso of inWindow) {
      expect(KOREAN_HOLIDAYS.matches('LEGAL_HOLIDAY', at(iso)), iso).toBe(true);
    }
  });
});
