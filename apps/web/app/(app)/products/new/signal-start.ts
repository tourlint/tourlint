/**
 * 레이더 「이 지역으로 새 상품 기획」 의 달(`?month=YYYY-MM`)로 출발일 초기값을 정한다 (FR-MO-061 · #764).
 *
 * 그 달 1일이다. 이 달이면 1일은 지났으니 오늘, 지난 달이면 채우지 않는다 — 지난 날짜를 넣으면
 * 저장하자마자 지난 상품이 된다. 사용자는 칸에서 바꾼다.
 */
export function startDateFromMonth(month: string, today: string): string | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const first = `${month}-01`;
  if (first >= today) return first;
  return today.slice(0, 7) === month ? today : null;
}
