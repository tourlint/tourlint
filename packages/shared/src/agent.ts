import type { ExceptionReasonCode } from './constants';

/**
 * 에이전트 응답 모양 (API 4-11 · F18). 에이전트는 제안만 하고 아무것도 바꾸지 않는다.
 *
 * 제안 · 이유 · 질문 · 할 일은 저장하지 않고 로그에도 남기지 않는다. 그 실행의 도구 결과에
 * 없던 contentid · 전화번호 · 상품 id 는 서버가 항목째 버린다 (FR-AG-001 – 004).
 */

export interface PlaceSuggestion {
  itemId: number;
  kind: 'FOUND' | 'NOT_FOUND' | 'NO_NAME';
  /** 제목 · 주소는 공사 원문 — 응답으로만 */
  place: { contentId: string; contentTypeId: number; title: string; kindName: string; addr: string | null } | null;
  alternatives: { contentId: string; title: string; kindName: string; distanceM: number | null }[];
  reason: string;
}

export interface CheckQuestionPlace {
  findingIds: number[];
  itemId: number;
  visit: { dayNo: number; date: string; start: string | null };
  /** 도구 결과에 없던 번호는 null 로 바뀐다 */
  tel: string | null;
  questions: string[];
}

export interface TodayItem {
  kind: 'CHANGE' | 'NEWS';
  productId: number | null;
  /** 시군구 코드(3자리)는 시도 코드와 함께여야 한 곳으로 정해진다. 세종은 `signguCd` 가 null. `month` 는 YYYY-MM */
  region: { regnCd: string; signguCd: string | null; month: string } | null;
  reason: string;
  /** `VIEW_RESULT` — 바뀐 뒤에 이미 다시 검수한 상품. 버튼은 「검수 결과 보기」 다 (#735) */
  action: 'REAUDIT' | 'VIEW_RESULT' | 'NEW_PLAN';
}

/**
 * 실행한 뒤의 실패 · 시간 초과(30초) · 예산 소진. 200 에 끝난 항목만 싣고 이것을 채운다.
 * 실행 전 거절은 이 모양이 아니라 429 다 (EX-AG-001 · 002 · 004). 레이더 에이전트는 `itemIds` 가 빈 배열.
 */
export interface AgentIncomplete {
  reasonCode: Extract<ExceptionReasonCode, 'LLM_UNAVAILABLE' | 'BUDGET_EXHAUSTED'>;
  itemIds: number[];
}
