import type { Transport } from '@tourlint/shared';
import { isKakaoError, type Coordinate, type KakaoMobilityClient } from '../external/kakao';

/**
 * 두 장소 사이 **차로 걸리는 시간**(분). 기획 화면의 장소 정보 한 줄과 항목 시각 채움이 같은
 * 함수를 쓴다 (FR-PL-005 · 013).
 *
 * **모르면 `null` 이다.** 좌표가 없거나(직접 정한 곳), 대중교통이거나(길찾기가 지원하지 않는다),
 * 조회에 실패하면 시간을 짓지 않는다 — 직선거리로 추정해 적으면 그 시간표로 움직이다 못 간다
 * (R08 과 같은 원칙 · EI-KM-009 · EX-PL-006).
 */
export async function estimateTravelMinutes(options: {
  readonly kakao: KakaoMobilityClient | null;
  readonly from: Coordinate | null;
  readonly to: Coordinate | null;
  readonly transport: Transport;
  /** `YYYYMMDDHHmm`. 없으면 현재 시각 기준으로 부른다 */
  readonly departureAt?: string | null;
}): Promise<number | null> {
  const { kakao, from, to, transport } = options;
  if (kakao === null || from === null || to === null) return null;
  // 대중교통 경로는 길찾기가 주지 않는다. 자동차 시간으로 대신 적지 않는다 (R08 TRANSIT_NOT_SUPPORTED)
  if (transport === 'PUBLIC_TRANSIT') return null;

  try {
    const route = await kakao.route(from, to, options.departureAt ?? null);
    return Math.round(route.durationSeconds / 60);
  } catch (e) {
    if (!isKakaoError(e)) throw e;
    return null;
  }
}

/** 좌표 둘이 다 있을 때만 좌표다. 하나라도 없으면 구간을 만들지 않는다 */
export function coordinateOf(mapx: number | null, mapy: number | null): Coordinate | null {
  return mapx === null || mapy === null ? null : { x: mapx, y: mapy };
}
