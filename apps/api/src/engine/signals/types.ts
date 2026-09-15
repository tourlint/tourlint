import type { IsoDate } from '../calendar/dates';

/**
 * 수요 신호 T1 · T2 · T3 (FR-RU-110 ~ 122 · FR-MO-059 · 060 · F14).
 *
 * ## 신호가 아닌 것
 *
 * ⚠️ **강도 점수를 내지 않는다** (FR-RU-121). 건수와 유형 분포로만 제시한다 — 「신호 강도
 *    7.2」 같은 값을 만드는 순간 그것은 관측이 아니라 예측이다.
 *
 * ⚠️ **SNS 언급량 · 검색 트렌드 · 혼잡도를 쓰지 않는다** (FR-RU-122). 공사 데이터에서
 *    관측되는 것만 쓴다 (FR-MO-054).
 *
 * 판매량 · 흥행 · 시장 반응은 말하지 않는다 (FR-MO-055). 우리가 아는 것은 「그 지역에
 * 최근 이런 것들이 새로 올라왔다」 와 「그 기간에 이런 행사가 열린다」 뿐이다.
 *
 * 순수 함수다 — 조회는 러너가 끝내고 넘긴다 (NF-PF-014 와 같은 취지).
 */

/** 유형별 건수. 키는 `contentTypeId` 문자열이다 */
export type TypeBreakdown = Readonly<Record<string, number>>;

/**
 * 관심 키워드 → 제목에 그 키워드가 들어간 `contentid` (FR-RU-112 · DR-PR-009).
 * **제목은 담지 않는다** — 이름은 화면이 표시할 때 조회한다.
 */
export type KeywordHits = Readonly<Record<string, readonly string[]>>;

/** 신호 하나. **건수와 분포뿐이다** */
export interface Signal {
  readonly count: number;
  readonly byType: TypeBreakdown;
  /**
   * 배치가 넘긴 키워드마다 한 줄이다. 맞는 곳이 없으면 빈 배열이고, 넘기지 않은 키워드는
   * 키가 없다 — 조회가 「세어 보니 없었다」와 「아직 안 봤다」를 가를 수 있게 한다.
   * T2 는 키워드로 보지 않아 비어 있다.
   */
  readonly byKeyword: KeywordHits;
  /** 산출에 쓴 조회 조건. 화면이 그대로 표시한다 (FR-MO-056) */
  readonly window: SignalWindow;
}

/** 어떤 조건으로 뽑았는지. 「최근 30일」 처럼 화면에 그대로 적는다 (FR-MO-056) */
export interface SignalWindow {
  readonly ldongRegnCd: string | null;
  readonly ldongSignguCd: string | null;
  readonly from: IsoDate;
  readonly to: IsoDate;
}

/**
 * 방문자수 응답 한 줄 (T3 · EI-KT-026). 지역 이름 · 요일 이름은 버리고 코드와 숫자만 둔다.
 */
export interface VisitorRow {
  /** 5자리 = `lDongRegnCd` + `lDongSignguCd`. 세종은 시도 코드 `36110` 그대로다 */
  readonly signguCode: string;
  readonly baseYmd: IsoDate | null;
  /** 1 현지인 · 2 외지인 · 3 외국인 */
  readonly touDivCd: string;
  /** 추정 방문자 수. 소수로 온다. 숫자가 아니면 null */
  readonly touNum: number | null;
}

/** T1 · T2 산출에 넣는 콘텐츠 한 줄. 목록 응답에서 이 필드만 쓴다 */
export interface SignalContent {
  readonly contentId: string;
  readonly contentTypeId: string;
  readonly ldongRegnCd: string | null;
  readonly ldongSignguCd: string | null;
  /** `YYYYMMDDHHmmss`. T1 의 근거 필드다 (FR-RU-110) */
  readonly createdTime: string;
  /** `YYYYMMDD`. T2 의 근거 필드다 (FR-RU-120). 행사가 아니면 null */
  readonly eventStart: IsoDate | null;
  readonly eventEnd: IsoDate | null;
  /** 제목에 들어간 관심 키워드 (FR-RU-112). 제목은 담지 않고 판정 결과만 넘긴다 */
  readonly matchedKeywords: readonly string[];
}
