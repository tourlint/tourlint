/**
 * 좌표 거리 (WGS84 경도 `x` · 위도 `y`).
 *
 * ⚠️ **판정에 쓰지 않는다.** 실제 이동시간은 지도 API 로만 얻는다 — 직선거리로 이동시간을
 *    추정해 오류를 내면 지어낸 값으로 사람을 움직이게 하는 셈이다 (R08 · EI-KM-009).
 *
 * 쓰는 곳은 **거르기**뿐이다. 「이 후보를 볼 만한가」 · 「이 순서가 저 순서보다 가까운가」를
 * 0콜로 판단한다. 결과는 반영 후 재검수에서 R08 이 실제 값으로 다시 본다.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** 두 좌표 사이 대권거리 (m) */
export function straightMeters(a: Point, b: Point): number {
  const R = 6_371_000;
  const rad = (d: number): number => (d * Math.PI) / 180;
  const dLat = rad(b.y - a.y);
  const dLon = rad(b.x - a.x);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.y)) * Math.cos(rad(b.y)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 좌표를 아는 항목만 점으로 만든다. 모르면 null — 0 으로 치면 적도 앞바다가 된다 */
export function pointOf(item: { mapX: number | null; mapY: number | null }): Point | null {
  return item.mapX === null || item.mapY === null ? null : { x: item.mapX, y: item.mapY };
}
