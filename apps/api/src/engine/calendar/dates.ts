import type { DayOfWeek, MonthDay } from '../normalize/types';
import { DAYS_OF_WEEK } from '../normalize/types';

/**
 * 규칙 평가용 날짜 산술 — **`Date` 를 쓰지 않는다.**
 *
 * `engine/rules` 는 `Date` 전역이 금지돼 있다(eslint 로 강제). 시간대·서머타임·시스템 시계에
 * 결과가 흔들리면 결정론성(NF-MT-001)이 깨지기 때문이다. 여기 있는 것은 전부 순수 산술이라
 * 어디서 몇 번을 돌려도 같은 답을 낸다.
 */

/** `YYYY-MM-DD` */
export type IsoDate = string;

export interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(iso: IsoDate): CalendarDate | null {
  const m = ISO_RE.exec(iso);
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function toMonthDay(d: CalendarDate): MonthDay {
  return `${pad2(d.month)}-${pad2(d.day)}`;
}

/**
 * 요일 — 젤러의 공식(Zeller's congruence).
 *
 * `new Date(iso).getDay()` 를 쓰면 실행 환경의 시간대에 따라 하루가 밀린다.
 * 순수 산술이면 그런 일이 없다.
 */
export function dayOfWeek(d: CalendarDate): DayOfWeek {
  // 1·2월은 전년도의 13·14월로 취급한다
  const m = d.month < 3 ? d.month + 12 : d.month;
  const y = d.month < 3 ? d.year - 1 : d.year;
  const K = y % 100;
  const J = Math.floor(y / 100);
  const h = (d.day + Math.floor((13 * (m + 1)) / 5) + K + Math.floor(K / 4) + Math.floor(J / 4) + 5 * J) % 7;
  // h: 0=토 1=일 2=월 … 6=금  →  스키마 표기(월 시작)로 옮긴다
  const index = (h + 5) % 7;
  return DAYS_OF_WEEK[index] as DayOfWeek;
}

/** 그 달에서 **몇 번째** 해당 요일인가. 1일부터 세어 1 ~ 5 */
export function nthWeekdayOfMonth(d: CalendarDate): number {
  return Math.floor((d.day - 1) / 7) + 1;
}

/**
 * `MM-DD` 구간에 드는가. **연말을 넘기는 구간을 허용한다** (`11-01` ~ `02-28`).
 *
 * 계절 운영시간이 겨울을 걸치는 게 실데이터의 기본형이라 단순 비교로는 안 된다.
 */
export function isWithinMonthDayRange(target: MonthDay, from: MonthDay, to: MonthDay): boolean {
  if (from <= to) return target >= from && target <= to;
  // 연말 넘김 — 구간이 두 조각으로 갈린다
  return target >= from || target <= to;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [1, 3, 5, 7, 8, 10, 12].includes(month) ? 31 : 30;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** 하루 뒤. 조건부 휴무(`공휴일인 경우 익일 휴관`) 판정에 쓴다 */
export function addDays(d: CalendarDate, days: number): CalendarDate {
  let { year, month, day } = d;
  day += days;
  while (day > daysInMonth(year, month)) {
    day -= daysInMonth(year, month);
    month++;
    if (month > 12) { month = 1; year++; }
  }
  while (day < 1) {
    month--;
    if (month < 1) { month = 12; year--; }
    day += daysInMonth(year, month);
  }
  return { year, month, day };
}

export function formatIsoDate(d: CalendarDate): IsoDate {
  return `${d.year}-${pad2(d.month)}-${pad2(d.day)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
