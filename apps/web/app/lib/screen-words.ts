// 화면 말 기준 낱말 검사 (UI-CM-040~043 · FR-PL-021). 만드는 쪽 말(호출 수 · 저장 방식 ·
// AI 도구 단계 · 출처 서비스 이름 · 지문 · 규칙셋 …)이 접힌 근거 칸 밖에 나오면 안 된다.
// 기획 화면(기획 · 장소 담기 · 기획 에이전트 카드)에는 판정 말(규칙 번호 · 등급)도 금지한다 —
// 판정은 검수의 몫이다. 등급 이름은 검수 결과 · 레이더에서는 명세 용어라 허용하므로 표를
// 화면별로 나눈다.

/** 다섯 화면 어디에도 접힌 근거 칸 밖에 나오면 안 되는 말 */
export const COMMON_FORBIDDEN = [
  "호출",
  "1콜",
  "원문",
  "지문",
  "규칙셋",
  "배치",
  "T1",
  "T2",
  "contentid",
  "사유코드",
  "두루누비",
  "무장애 여행 정보",
  "연관 관광지",
  "이동통신",
  "AI 추천",
  "AI가 판정",
] as const;

/** 기획 화면에서만 추가로 막는 판정 말 (규칙 번호 · 등급) */
export const PLAN_ONLY_FORBIDDEN = [
  "R01", "R02", "R03", "R04", "R05", "R06", "R07", "R08", "R09", "R10",
  "통과",
  "주의",
  "차단",
  "오류",
  "확인 불가",
] as const;

export function forbiddenWords(planScreen: boolean): string[] {
  return planScreen ? [...COMMON_FORBIDDEN, ...PLAN_ONLY_FORBIDDEN] : [...COMMON_FORBIDDEN];
}

/**
 * 접힌 근거 칸(`data-evidence`)이 붙은 요소의 내용을 뺀 화면 글자. 근거 칸 안의 말은 검사
 * 대상이 아니다 — 규칙셋 · 지문 · 출처는 거기 있어도 된다 (UI-CM-030 · 031).
 */
export function visibleText(html: string): string {
  return html.replace(/<([a-z]+)[^>]*\bdata-evidence\b[^>]*>[\s\S]*?<\/\1>/gi, "");
}

/** 화면 HTML 에서 금지 낱말을 찾는다. 접힌 근거 칸은 먼저 뺀다. */
export function findForbidden(html: string, planScreen: boolean): string[] {
  const visible = visibleText(html);
  return forbiddenWords(planScreen).filter((w) => visible.includes(w));
}
