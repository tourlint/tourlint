import type { HolidayRule } from '../normalize/types';
import { toMonthDay, type CalendarDate } from './dates';

/**
 * 공휴일 표 (DR-NM-025).
 *
 * 명절은 음력 기준이라 양력 날짜가 해마다 다르다. 계산으로 풀려면 음양력 변환기가 필요한데,
 * 그건 **외부 연동 추가**에 해당해 서비스 범위 개정 절차를 거쳐야 한다(EI-CM-010).
 * 표를 박아두는 편이 결정론적이고 검증 가능하다.
 *
 * ⚠️ **출처와 한계**
 * - 관공서의 공휴일에 관한 규정 기준. 2026년은 공모전 시연 기간(8~10월)을 포함한다.
 * - **표에 없는 연도는 "모른다" 로 답한다** (`isSupportedYear`). 조용히 "공휴일 아님" 을
 *   돌려주면 그 해 전체의 휴무 판정이 소리 없이 틀린다.
 * - 2027년 명절 날짜는 서비스가 실제로 2027년을 다루기 전에 한국천문연구원 특일 정보로
 *   교차 확인할 것.
 */

export const SUPPORTED_YEARS = [2026, 2027] as const;

interface YearHolidays {
  /** 설날 **당일** */
  readonly lunarNewYear: string;
  /** 추석 **당일** */
  readonly chuseok: string;
  /** 법정공휴일 `MM-DD` 전체. 대체공휴일 포함 */
  readonly legal: readonly string[];
  /** 화면·메시지에 쓸 이름 */
  readonly names: Readonly<Record<string, string>>;
}

const TABLE: Readonly<Record<number, YearHolidays>> = {
  2026: {
    lunarNewYear: '02-17',
    chuseok: '09-25',
    legal: [
      '01-01', '02-16', '02-17', '02-18', '03-01', '03-02', '05-05', '05-24', '05-25',
      '06-06', '08-15', '08-17', '09-24', '09-25', '09-26', '10-03', '10-05', '10-09', '12-25',
    ],
    names: {
      '01-01': '신정', '02-16': '설날 연휴', '02-17': '설날', '02-18': '설날 연휴',
      '03-01': '삼일절', '03-02': '삼일절 대체공휴일', '05-05': '어린이날',
      '05-24': '부처님오신날', '05-25': '부처님오신날 대체공휴일', '06-06': '현충일',
      '08-15': '광복절', '08-17': '광복절 대체공휴일', '09-24': '추석 연휴', '09-25': '추석',
      '09-26': '추석 연휴', '10-03': '개천절', '10-05': '개천절 대체공휴일',
      '10-09': '한글날', '12-25': '성탄절',
    },
  },
  2027: {
    lunarNewYear: '02-06',
    chuseok: '09-15',
    legal: [
      '01-01', '02-05', '02-06', '02-07', '02-08', '03-01', '05-05', '05-13',
      '06-06', '06-07', '08-15', '08-16', '09-14', '09-15', '09-16', '10-03', '10-04', '10-09', '10-11', '12-25',
    ],
    names: {
      '01-01': '신정', '02-05': '설날 연휴', '02-06': '설날', '02-07': '설날 연휴',
      '02-08': '설날 대체공휴일', '03-01': '삼일절', '05-05': '어린이날', '05-13': '부처님오신날',
      '06-06': '현충일', '06-07': '현충일 대체공휴일', '08-15': '광복절', '08-16': '광복절 대체공휴일',
      '09-14': '추석 연휴', '09-15': '추석', '09-16': '추석 연휴', '10-03': '개천절',
      '10-04': '개천절 대체공휴일', '10-09': '한글날', '10-11': '한글날 대체공휴일', '12-25': '성탄절',
    },
  },
};

/**
 * 규칙이 보는 달력. 인터페이스로 둔 이유는 **표를 바꾸지 않고 시험하기 위해서**다.
 * 규칙 테스트가 실제 공휴일 날짜에 얽매이면 표가 바뀔 때마다 규칙 테스트가 깨진다.
 */
export interface HolidayCalendar {
  isSupportedYear(year: number): boolean;
  matches(rule: HolidayRule, date: CalendarDate): boolean;
  nameOf(date: CalendarDate): string | null;
}

export const KOREAN_HOLIDAYS: HolidayCalendar = {
  isSupportedYear(year) {
    return TABLE[year] !== undefined;
  },

  /**
   * `holidayRule` 하나가 그 날짜에 해당하는가.
   *
   * 명절은 **당일만** 본다. 실측 원문의 압도적 다수가 `설·추석 당일` 이고(287건 중 명절 표기
   * 전부), 연휴 전체를 휴무로 읽으면 실제로 여는 날을 닫혔다고 판정한다. 과탐 쪽이 더 나쁘다.
   */
  matches(rule, date) {
    const year = TABLE[date.year];
    if (year === undefined) return false;
    const md = toMonthDay(date);

    switch (rule) {
      case 'LUNAR_NEW_YEAR': return md === year.lunarNewYear;
      case 'CHUSEOK': return md === year.chuseok;
      case 'LEGAL_HOLIDAY': return year.legal.includes(md);
      default: return false;
    }
  },

  nameOf(date) {
    return TABLE[date.year]?.names[toMonthDay(date)] ?? null;
  },
};
