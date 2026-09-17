// 규칙을 사용자 말로 (UI-S3-013 · 기획안 4-5). 검수 결과 화면 머리에 규칙 번호 대신 이 이름을
// 쓴다 — 번호(R01…)는 근거 보기 안으로 들어간다. 엔진의 기술적 이름과 달리 실무자 말이다.

export const RULE_NAMES: Record<string, string> = {
  R01: "쉬는 날 · 운영시간",
  R02: "행사 기간",
  R03: "일정 시간 겹침",
  R04: "종류 쏠림",
  R05: "확정되지 않은 곳",
  R06: "정보 바뀜",
  R07: "식사 · 휴식",
  R08: "이동 시간",
  R09: "날씨 · 우천",
  R10: "상품 구성",
};

export function ruleName(code: string): string {
  return RULE_NAMES[code] ?? code;
}
