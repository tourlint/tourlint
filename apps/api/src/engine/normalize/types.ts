import type { ParseConfidence, UnparsedReason } from '@tourlint/shared';

/**
 * 운영정보 정규화 스키마 (DR-NM 5-2).
 *
 * 자유 텍스트를 규칙엔진이 **결정론적으로** 평가할 수 있는 구조로 바꾸는 계약이다.
 * 축이 둘이고 평가 순서가 다르다 (DR-NM-001) — 휴무(닫힘)를 먼저 보고, 닫혀 있으면
 * 운영시간은 보지 않는다 (DR-NM-021).
 */

export const SCHEMA_VERSION = '1.0';

/** 요일 — `MON` ~ `SUN` 대문자 3자 (DR-NM-003) */
export const DAYS_OF_WEEK = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type DayOfWeek = (typeof DAYS_OF_WEEK)[number];

/** 명절·법정공휴일 열거 (DR-NM 5-3) */
export const HOLIDAY_RULES = ['LUNAR_NEW_YEAR', 'CHUSEOK', 'LEGAL_HOLIDAY'] as const;
export type HolidayRule = (typeof HOLIDAY_RULES)[number];

/** `HH:mm` 24시간제. 하루 끝은 `24:00` 으로 적는다 — 실측 원문에도 `00:00~24:00` 이 있다 */
export type TimeOfDay = string;
/** `MM-DD` */
export type MonthDay = string;

export interface TimeSpan {
  readonly from: TimeOfDay;
  readonly to: TimeOfDay;
}

/** 운영시간 한 덩어리. 요일별·계절별 항목도 같은 모양을 쓴다 */
export interface HoursEntry {
  readonly open: TimeOfDay;
  /** `open` 보다 이르면 익일 종료(심야 영업)다 (DR-NM-023) */
  readonly close: TimeOfDay;
  /** 영업시간 내 휴게·준비시간. 이 구간 방문은 주의다 */
  readonly breaks: readonly TimeSpan[];
  /** 매표·입장·마지막 주문 마감. 항목마다 개별로 갖는다 (DR-NM-015) */
  readonly admissionCutoff: TimeOfDay | null;
}

export interface DayOfWeekHours extends HoursEntry {
  /** 서로 겹치지 않아야 한다 (DR-NM-016) */
  readonly days: readonly DayOfWeek[];
}

export interface SeasonalHours extends HoursEntry {
  /** 연말 넘김 허용 (`11-01` ~ `02-28`) */
  readonly from: MonthDay;
  readonly to: MonthDay;
  readonly label: string | null;
}

export interface NthWeekday {
  /** 1 ~ 5 */
  readonly nth: number;
  readonly day: DayOfWeek;
}

export interface ConditionalRule {
  readonly kind: 'HOLIDAY_NEXT_DAY' | 'OTHER';
  readonly appliesTo: readonly DayOfWeek[];
  readonly note: string;
}

/** 시설 **일부만** 휴관. 전체 휴무로 판정하지 않는다 (DR-NM-012) */
export interface PartialClosed {
  readonly scope: string;
  readonly on: readonly (MonthDay | HolidayRule)[];
}

export interface UnparsedFragment {
  /** 분해된 조각만 담는다. 원문 전문 복사 금지, 200자 초과 시 절단 (DR-NM-014) */
  readonly fragment: string;
  readonly reason: UnparsedReason;
  /** 영향받는 필드 경로. **비어 있으면 어떤 경로도 강등하지 않는다** */
  readonly affects: readonly string[];
}

export interface ConfidenceBlock {
  /** `byPath` 의 최솟값. **규칙 판정에 쓰지 않는다** — 화면 요약 전용 (DR-NM-034) */
  readonly overall: ParseConfidence;
  readonly byPath: Readonly<Record<string, ParseConfidence>>;
}

export interface NormalizedOperatingInfo {
  readonly schemaVersion: string;
  /** 해석에 사용한 공사 **필드명**. 값이 아니다 */
  readonly sourceFieldNames: readonly string[];

  // ── 휴무 축 ──
  /** `true` 면 다른 휴무 필드가 비어 있어야 한다. `partialClosed` 는 예외다 */
  readonly alwaysOpen: boolean;
  readonly weeklyClosed: readonly DayOfWeek[];
  readonly nthWeekday: readonly NthWeekday[];
  readonly fixedClosed: readonly MonthDay[];
  readonly holidayRule: readonly HolidayRule[];
  readonly conditionalRule: readonly ConditionalRule[];
  readonly partialClosed: readonly PartialClosed[];

  // ── 운영시간 축 ──
  readonly openHours: HoursEntry | null;
  readonly dayOfWeekHours: readonly DayOfWeekHours[];
  readonly seasonalHours: readonly SeasonalHours[];

  /** 숙박(32) 전용. 그 밖의 유형에도 입실/퇴실 원문이 담길 수 있다 (DR-NM-026) */
  readonly checkIn: TimeOfDay | null;
  readonly checkOut: TimeOfDay | null;

  readonly confidence: ConfidenceBlock;
  readonly unparsed: readonly UnparsedFragment[];
}

/** 스키마의 빈 상태. 파서는 여기서 출발해 채워 나간다 */
export function emptyNormalized(sourceFieldNames: readonly string[]): NormalizedOperatingInfo {
  return {
    schemaVersion: SCHEMA_VERSION,
    sourceFieldNames,
    alwaysOpen: false,
    weeklyClosed: [],
    nthWeekday: [],
    fixedClosed: [],
    holidayRule: [],
    conditionalRule: [],
    partialClosed: [],
    openHours: null,
    dayOfWeekHours: [],
    seasonalHours: [],
    checkIn: null,
    checkOut: null,
    confidence: { overall: 'UNPARSED', byPath: {} },
    unparsed: [],
  };
}

/** 신뢰도 순서 — `CONFIRMED` > `ESTIMATED` > `UNPARSED` (DR-NM-030) */
export const CONFIDENCE_ORDER: Readonly<Record<ParseConfidence, number>> = {
  CONFIRMED: 2,
  ESTIMATED: 1,
  UNPARSED: 0,
};

export function lowerConfidence(a: ParseConfidence, b: ParseConfidence): ParseConfidence {
  return CONFIDENCE_ORDER[a] <= CONFIDENCE_ORDER[b] ? a : b;
}
