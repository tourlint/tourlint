import { describe, expect, it } from 'vitest';
import {
  addDays, dayOfWeek, formatIsoDate, isWithinMonthDayRange, nthWeekdayOfMonth,
  parseIsoDate, toMonthDay,
} from './dates';

const at = (iso: string): NonNullable<ReturnType<typeof parseIsoDate>> => {
  const d = parseIsoDate(iso);
  if (d === null) throw new Error(`잘못된 날짜: ${iso}`);
  return d;
};

describe('dayOfWeek — Date 없이 순수 산술로 (NF-MT-001)', () => {
  it('기대값표 §1 의 2026년 10월 요일과 정확히 일치한다', () => {
    // 회귀 정답셋 전체가 이 요일 계산 위에 서 있다
    const expected: Record<string, string> = {
      '2026-10-01': 'THU', '2026-10-02': 'FRI', '2026-10-03': 'SAT', '2026-10-04': 'SUN',
      '2026-10-05': 'MON', '2026-10-06': 'TUE', '2026-10-07': 'WED', '2026-10-08': 'THU',
      '2026-10-09': 'FRI', '2026-10-10': 'SAT', '2026-10-13': 'TUE', '2026-10-14': 'WED',
      '2026-10-15': 'THU', '2026-10-16': 'FRI', '2026-10-17': 'SAT',
    };
    for (const [iso, day] of Object.entries(expected)) {
      expect(dayOfWeek(at(iso)), iso).toBe(day);
    }
  });

  it('윤년 2월 29일도 맞다', () => {
    expect(dayOfWeek(at('2024-02-29'))).toBe('THU');
    expect(dayOfWeek(at('2028-02-29'))).toBe('TUE');
  });

  it('세기 경계를 넘어도 맞다', () => {
    expect(dayOfWeek(at('2000-01-01'))).toBe('SAT');
    expect(dayOfWeek(at('1999-12-31'))).toBe('FRI');
  });
});

describe('parseIsoDate', () => {
  it.each(['2026-13-01', '2026-02-30', '2026-00-10', '26-10-08', '2026-10-8', ''])(
    '%s 는 받지 않는다', (iso) => { expect(parseIsoDate(iso)).toBeNull(); },
  );

  it('윤년이 아니면 2월 29일을 받지 않는다', () => {
    expect(parseIsoDate('2026-02-29')).toBeNull();
    expect(parseIsoDate('2028-02-29')).not.toBeNull();
  });

  it('MM-DD 로 옮긴다', () => {
    expect(toMonthDay(at('2026-01-01'))).toBe('01-01');
  });
});

describe('nthWeekdayOfMonth — 매월 N번째 요일 (1-3 단계)', () => {
  it.each([[1, 1], [7, 1], [8, 2], [14, 2], [15, 3], [21, 3], [22, 4], [28, 4], [29, 5]])(
    '%i일은 %i번째다', (day, nth) => {
      expect(nthWeekdayOfMonth(at(`2026-10-${String(day).padStart(2, '0')}`))).toBe(nth);
    },
  );

  it('셋째 월요일은 2026-10-19 다', () => {
    const d = at('2026-10-19');
    expect(dayOfWeek(d)).toBe('MON');
    expect(nthWeekdayOfMonth(d)).toBe(3);
  });
});

describe('isWithinMonthDayRange — 연말을 넘기는 구간 (계절 운영시간)', () => {
  it('평범한 구간', () => {
    expect(isWithinMonthDayRange('05-01', '03-01', '10-31')).toBe(true);
    expect(isWithinMonthDayRange('11-15', '03-01', '10-31')).toBe(false);
  });

  it('연말을 넘기면 구간이 두 조각으로 갈린다', () => {
    expect(isWithinMonthDayRange('12-15', '11-01', '02-28')).toBe(true);
    expect(isWithinMonthDayRange('01-15', '11-01', '02-28')).toBe(true);
    expect(isWithinMonthDayRange('06-15', '11-01', '02-28')).toBe(false);
  });

  it('경계는 포함이다', () => {
    expect(isWithinMonthDayRange('03-01', '03-01', '10-31')).toBe(true);
    expect(isWithinMonthDayRange('10-31', '03-01', '10-31')).toBe(true);
  });
});

describe('addDays — 조건부 휴무의 익일 판정에 쓴다', () => {
  it.each([
    ['2026-10-08', 1, '2026-10-09'],
    ['2026-10-31', 1, '2026-11-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-03-01', -1, '2026-02-28'],
    ['2028-03-01', -1, '2028-02-29'],
  ])('%s %+i일 → %s', (from, n, to) => {
    expect(formatIsoDate(addDays(at(from), n))).toBe(to);
  });
});
