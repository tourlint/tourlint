/** 한국 표준시 오프셋. 서머타임이 없어 상수다 */
const KST_OFFSET_MS = 9 * 60 * 60_000;

/**
 * 일시를 **KST ISO 8601** 로 적는다 — `2026-09-15T14:32:07+09:00` (TM-015 · API 설계 3-2).
 *
 * `Date.toISOString()` 은 UTC(`…Z`)다. 화면과 PDF 는 받은 문자열을 그대로 잘라 쓰므로
 * 그대로 내보내면 **9시간 이르게 보인다** — 오전에 돌린 검수가 새벽으로 찍혔다.
 * 자르는 쪽을 고치는 대신 내보내는 자리에서 맞춘다. 화면 · 리포트가 같은 값을 쓴다.
 *
 * 날짜만 필요한 곳(`YYYY-MM-DD`)은 이 함수를 쓰지 않는다 — 그쪽은 이미 +9시간 보정이
 * 붙어 있거나 UTC 자정 기준으로 날짜를 더하고 빼는 계산이다.
 */
export function kstIso(date: Date): string {
  return `${new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, 19)}+09:00`;
}
