/**
 * 두 좌표 사이의 직선거리(m). 이동시간이 아니다 — 시간은 길찾기만 말할 수 있다 (R08 과 같은 원칙).
 *
 * 에이전트 장소 찾기(FR-AG-010)와 장소 담기 가까운 순(FR-PL-011)이 같이 쓴다.
 */
export function straightDistanceM(
  from: { mapx: number; mapy: number } | null,
  to: { mapx: number; mapy: number } | null,
): number | null {
  if (from === null || to === null) return null;
  const rad = Math.PI / 180;
  const meanLat = ((from.mapy + to.mapy) / 2) * rad;
  const dx = (to.mapx - from.mapx) * rad * Math.cos(meanLat);
  const dy = (to.mapy - from.mapy) * rad;
  return Math.round(Math.sqrt(dx * dx + dy * dy) * 6_371_000);
}
