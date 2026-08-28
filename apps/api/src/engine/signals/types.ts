import type { IsoDate } from '../calendar/dates';

/**
 * 수요 신호 T1 · T2 (FR-RU-110 ~ 122 · F14).
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

/** 신호 하나. **건수와 분포뿐이다** */
export interface Signal {
  readonly count: number;
  readonly byType: TypeBreakdown;
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
  /** 관심 키워드 필터용 (FR-RU-112). 원문을 담지 않으므로 러너가 판정만 해서 넘긴다 */
  readonly matchesKeyword: boolean;
}
