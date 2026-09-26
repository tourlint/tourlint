// 오늘 할 일 카드의 말 (UI-S7-018 · FR-AG-005). 정리 결과와 AI 가 끝까지 못 했을 때를 가른다.

import { isApiError, type TodayBrief } from "./api";
import { checkedBasisText } from "./radar-time";

/**
 * AI 가 끝까지 정리하지 못했을 때 어느 경우든 보이는 말 (FR-AG-005 · EX-AG-001). 실패 · 시간 초과 ·
 * 예산 소진을 「챙길 일이 없어요」로 적으면 모르는 것을 없다고 말하는 것이다 (설계 원칙 3).
 */
export const AI_UNAVAILABLE = "지금은 AI로 정리할 수 없어요";

/**
 * 까닭 한 줄. 사유 코드는 화면에 적지 않는다. 검수 화면의 물어볼 내용 카드와 같은 말을 쓴다 —
 * 같은 사정을 화면마다 다르게 적지 않는다.
 */
export function aiUnavailableReason(reasonCode: string | null | undefined): string {
  return reasonCode === "BUDGET_EXHAUSTED"
    ? "오늘 쓸 수 있는 관광정보 조회를 모두 썼어요. 내일 다시 눌러 주세요."
    : "AI가 지금 응답하지 않아요. 잠시 후 다시 눌러 주세요.";
}

/**
 * 결과 카드 제목 — 「오늘 할 일 N · 오늘 오전 5시 확인 기준」 (UI-S7-018). 끝까지 정리하지 못했으면 N 을
 * 적지 않는다 — 정리한 것만 세면 할 일이 그것뿐인 것처럼 읽힌다.
 */
export function todayTitle(brief: TodayBrief | null, todayIso: string): string {
  if (brief === null) return "오늘 할 일";
  const basis = checkedBasisText(brief.basisAt, todayIso);
  return brief.incomplete === null ? `오늘 할 일 ${String(brief.todos.length)} · ${basis}` : `오늘 할 일 · ${basis}`;
}

/**
 * 요청이 실패했을 때. 동시 실행 · 연타 제한(429 `RATE_LIMIT_EXCEEDED`)은 AI 가 못 한 것이 아니라 기다리면
 * 되는 일이라 서버 문장을 그대로 쓴다. 그 밖은 AI 로 정리하지 못한 것이다.
 */
export function todayFailure(err: unknown): { unavailable: true; reason: string } | { unavailable: false; message: string } {
  if (isApiError(err) && err.reasonCode === "RATE_LIMIT_EXCEEDED") return { unavailable: false, message: err.message };
  return { unavailable: true, reason: aiUnavailableReason(isApiError(err) ? err.reasonCode : null) };
}
