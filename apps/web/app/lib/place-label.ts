// 이름을 불러오지 못한 고른 곳의 대체 표시 (#908 · #911 리뷰).
//
// 장소 담기 · 등록 화면에서 고른 곳은 이름을 저장하지 않고 볼 때 찾는다(DR-PR-001). 조회가 실패하거나
// 오늘 쓸 수 있는 관광정보 조회를 다 쓰면 이름이 빈 채로 온다. 그 줄에 「장소를 골라 주세요」 ·
// 「(이름 미입력)」 을 붙이면 고른 곳을 고르지 않은 것처럼 보인다. 저장 방식은 말하지 않는다 (UI-CM-040).

/** 이름을 불러오지 못한 고른 곳 */
export const UNNAMED_PICKED = "이름을 불러오지 못한 곳";

/**
 * 줄의 보일 이름. 이름이 있으면 그것, 고른 곳인데 비었으면 `UNNAMED_PICKED`, 그 밖에는 `null` —
 * 부르는 쪽이 제 대체 표시를 쓴다.
 */
export function shownPlace(item: { place: string; matchStatus: string }): string | null {
  const name = item.place.trim();
  if (name !== "") return name;
  return item.matchStatus === "CONFIRMED" ? UNNAMED_PICKED : null;
}
