// 기획 화면 자동 저장 표시 (개편안 4-1 변경 지점 8). 편집이 저장될 때마다 "자동 저장됨 hh:mm"
// 으로 갱신한다. 저장은 항목 API 가 즉시 하므로 여기서는 표시 문구만 만든다.

/** 로컬 시각 시:분 (예: 09:41). 자동 저장 표시에만 쓴다. */
export function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 자동 저장 라벨. 아직 이번 세션에서 저장한 적이 없으면(상품은 이미 저장돼 있으므로) 시각
 * 없이 "자동 저장됨"만, 저장이 일어난 뒤에는 그 시각을 붙인다.
 */
export function savedLabel(at: string | null): string {
  return at === null ? "자동 저장됨" : `자동 저장됨 ${at}`;
}
