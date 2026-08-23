import { SETTING_DEFAULTS } from '@tourlint/shared';
import type {
  ContentTypeId, EndTimeSource, ExceptionReasonCode, ItemType, MatchStatus,
  ParseConfidence, ReasonCode, Severity,
} from '@tourlint/shared';
import type { ChangeVerdict } from '../fingerprint/types';
import type { HolidayCalendar } from '../calendar/holidays';
import type { IsoDate } from '../calendar/dates';
import type { NormalizedOperatingInfo, TimeOfDay } from '../normalize/types';

/**
 * 규칙 평가의 공용 계약 (API 설계 §2 · NF-MT-001 · 002).
 *
 * **규칙은 외부를 직접 호출하지 않는다.** 판정에 필요한 데이터는 `AuditRunner` 가 미리 모아
 * `ItineraryContext` 로 넘기고, 규칙은 **메모리 상에서만** 평가한다 (NF-PF-014).
 * 이 경계가 결정론성을 구조적으로 보장하는 장치다 — 규칙이 개별적으로 외부를 부르면
 * 같은 입력에 다른 결과가 나온다.
 *
 * 규칙끼리도 서로 참조하지 않는다 (NF-MT-002).
 */

/** 일정 항목에 붙은 공사 콘텐츠. 매칭에 실패했으면 항목의 `content` 가 null 이다 */
export interface MatchedContent {
  readonly ktoContentId: string;
  readonly contentTypeId: ContentTypeId;
  /** 파싱이 전면 실패하면 null (DB `normalized_json` 이 NULL 인 경우와 같다) */
  readonly normalized: NormalizedOperatingInfo | null;
  /** 1 = 표출 · 0 = 비표출 */
  readonly showFlag: 0 | 1;
  /**
   * 행사(15) 개최 기간. 그 밖의 유형은 null.
   *
   * 운영정보 스키마(DR-NM)에 두지 않은 이유 — 그 스키마는 **휴무와 운영시간** 두 축의 계약이고,
   * 행사 기간은 다른 축이다. 러너가 `detailIntro2` 의 `eventstartdate` · `eventenddate` 를
   * `YYYYMMDD` → `YYYY-MM-DD` 로 옮겨 넣는다. **결측이면 null 이며 차단하지 않는다** (FR-RU-023).
   */
  readonly eventPeriod: { readonly start: IsoDate | null; readonly end: IsoDate | null } | null;
  /**
   * 직전 지문과 비교한 결과. 러너가 채운다 (FR-MO-004).
   *
   * 규칙이 DB 를 읽지 않게 하려고 여기 담는다 — 규칙 평가는 메모리 전용이다 (NF-PF-014).
   * 직전 지문이 없으면 `FIRST` 이고, 지문 자체를 못 만들었으면 null 이다.
   */
  readonly changeVerdict: ChangeVerdict | null;
}

export interface AuditItem {
  readonly id: number;
  readonly dayNo: number;
  readonly seq: number;
  /** 방문 예정일. 상품 출발일 + (dayNo − 1) 을 러너가 미리 계산해 넣는다 */
  readonly date: IsoDate;
  readonly startTime: TimeOfDay;
  /** 미입력이면 체류시간으로 보완된 값. 보완도 못 했으면 null */
  readonly endTime: TimeOfDay | null;
  /** 종료시간의 출처. 보완값으로 내린 판정은 그 사실을 메시지에 밝혀야 한다 (FR-RU-031) */
  readonly endTimeSource: EndTimeSource;
  /** 신분류체계 대분류(2자). R04 집계의 상위 축 */
  readonly lclsSystm1: string | null;
  /** 중분류(4자). 체류시간 보완과 R09 실내외 판정의 입력 */
  readonly lclsSystm2: string | null;
  /** 소분류(8자). R04 집계 축. 상세 조회에는 없고 공통·목록 조회에서 수집한다 (EI-KT-018) */
  readonly lclsSystm3: string | null;
  readonly itemType: ItemType;
  /** **사용자가 입력한** 일정 항목명. 공사 원문이 아니다 (DR-PR-001) */
  readonly placeLabel: string;
  readonly matchStatus: MatchStatus;
  readonly content: MatchedContent | null;
}

/**
 * 판정에 쓰는 계정 설정 (`user_setting`).
 *
 * 설정 화면에서 조정할 수 있어야 하므로(FR-RU-072 · FR-OP-021) 규칙이 상수를 직접 읽지 않고
 * 러너가 주입한다. 변경은 다음 검수부터 적용되고 과거 결과를 소급하지 않는다 (FR-OP-026).
 */
export interface AuditSettings {
  /** R07 연속 일정 기준 시간 */
  readonly r07SpanHours: number;
  /** R07 최소 식사 시간(분) */
  readonly r07MealMinutes: number;
  /** R04 콘텐츠 편중 임계 */
  readonly r04Threshold: number;
  /**
   * R04 집계에서 뺄 분류코드 (FR-RU-042).
   *
   * 상품 콘셉트에 반복이 의도된 키워드("카페투어" · "미식" · "사찰순례")가 있으면 그 유형을
   * 판정에서 제외한다. **키워드를 분류코드로 옮기는 표는 아직 없다** — 분류체계 59행이
   * 들어오는 W3 에 붙인다. 그때까지는 비어 있고, 기제는 여기 준비돼 있다.
   */
  readonly r04ExcludedKeys: readonly string[];
}

/** 계정 설정을 아직 읽지 않았을 때 쓰는 기본값 (`SETTING_DEFAULTS`) */
export const DEFAULT_AUDIT_SETTINGS: AuditSettings = {
  r07SpanHours: SETTING_DEFAULTS.r07SpanHours,
  r07MealMinutes: SETTING_DEFAULTS.r07MealMinutes,
  r04Threshold: SETTING_DEFAULTS.r04Threshold,
  r04ExcludedKeys: [],
};

export interface ItineraryContext {
  readonly productId: number;
  readonly items: readonly AuditItem[];
  /** 규칙이 시계를 보지 않게 달력을 주입한다 (NF-MT-001) */
  readonly holidays: HolidayCalendar;
  readonly settings: AuditSettings;
}

/**
 * 규칙이 만든 판정 1건. `finding` 테이블 한 행에 대응한다.
 *
 * `evidence` 에는 **판정 입력값만** 담는다. 공사 원문은 넣지 않는다 (DR-PR-001).
 * 정규화 결과는 우리 산출물이므로 담아도 된다.
 */
export interface Finding {
  readonly ruleCode: string;
  readonly ruleVersion: string;
  readonly severity: Severity;
  /**
   * 판정 사유코드 또는 예외 사유코드. **두 네임스페이스가 공존한다** (EX-CM-002).
   * R06 의 비표출 전환처럼 판정 사유코드 15종에 없는 경우가 있다.
   */
  readonly reasonCode: ReasonCode | ExceptionReasonCode;
  /**
   * 지목하는 일정 항목. **일차 단위 · 상품 단위 판정은 null 이다** (R04 · R07 · R10).
   * DB `finding.target_item_id` 도 NULL 을 허용한다.
   */
  readonly targetItemId: number | null;
  readonly targetItemId2?: number;
  readonly message: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly requiresExternal: boolean;
  readonly externalSource: string | null;
  /**
   * 확인 필요 목록에 함께 등록할지 (FR-AU-008).
   *
   * `finding` 테이블에 전용 컬럼이 없어 저장 시 `evidence` 로 내려간다.
   * 목록에서 체크한 시각은 `confirmed_at` 이 갖는다.
   */
  readonly needsConfirmation: boolean;
}

export interface AuditRule {
  readonly code: string;
  readonly version: string;
  /** 이 규칙이 기본으로 내는 등급. 신뢰도 게이트로 강등될 수 있다 */
  readonly defaultSeverity: Severity | null;
  /** true 면 "외부 참고" 배지를 자동 부착한다 (EI-CM-008) */
  readonly requiresExternal: boolean;
  evaluate(ctx: ItineraryContext): readonly Finding[];
}

/** 규칙이 참조한 경로의 신뢰도만 본다 — `confidence.overall` 은 쓰지 않는다 (DR-NM-034) */
export function confidenceOfPaths(
  normalized: NormalizedOperatingInfo,
  paths: readonly string[],
): ParseConfidence {
  let worst: ParseConfidence | null = null;
  for (const p of paths) {
    const c = normalized.confidence.byPath[p];
    if (c === undefined) continue;
    if (worst === null || RANK[c] < RANK[worst]) worst = c;
  }
  return worst ?? 'UNPARSED';
}

const RANK: Readonly<Record<ParseConfidence, number>> = { CONFIRMED: 2, ESTIMATED: 1, UNPARSED: 0 };
