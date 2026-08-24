/**
 * 위경도 → 기상청 단기예보 격자 (EI-WX-002).
 *
 * 단기예보는 전국을 5km × 5km 격자로 나눠 제공하고 `nx` · `ny` 로만 조회를 받는다.
 * 공사 콘텐츠는 `mapx`(경도) · `mapy`(위도) 를 주므로 그 사이를 메우는 변환이 필요하다.
 *
 * 기상청이 쓰는 것은 **람베르트 정각 원뿔 도법**이고 아래 상수가 그 파라미터다.
 * 값을 바꾸면 격자가 통째로 어긋나므로 손대지 않는다.
 *
 * **순수 함수다.** 시계도 난수도 외부 호출도 없다 (NF-MT-001).
 */

/** 지구 반경 (km) */
const EARTH_RADIUS = 6371.00877;
/** 격자 간격 (km) */
const GRID_KM = 5.0;
/** 표준 위도 1 · 2 (도) */
const STANDARD_LAT_1 = 30.0;
const STANDARD_LAT_2 = 60.0;
/** 기준점 경도 · 위도 (도) */
const ORIGIN_LON = 126.0;
const ORIGIN_LAT = 38.0;
/** 기준점의 격자 좌표 */
const ORIGIN_X = 43;
const ORIGIN_Y = 136;

const DEGRAD = Math.PI / 180.0;

export interface GridPoint {
  readonly nx: number;
  readonly ny: number;
}

/**
 * 격자 좌표로 바꾼다. 좌표가 없으면 `null` — 지어내지 않는다.
 *
 * 대한민국 밖 좌표도 수식상 값이 나오긴 하는데, 그 격자에는 예보가 없어서 조회하면
 * 빈 응답이 온다. 여기서 막지 않고 클라이언트가 빈 응답을 확인 불가로 옮긴다 —
 * "격자 밖" 과 "예보 없음" 을 우리가 구분해 말할 근거가 없다.
 */
export function toGrid(lon: number | null, lat: number | null): GridPoint | null {
  if (lon === null || lat === null) return null;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

  const re = EARTH_RADIUS / GRID_KM;
  const slat1 = STANDARD_LAT_1 * DEGRAD;
  const slat2 = STANDARD_LAT_2 * DEGRAD;
  const olon = ORIGIN_LON * DEGRAD;
  const olat = ORIGIN_LAT * DEGRAD;

  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = (re * sf) / Math.pow(ro, sn);

  let ra = Math.tan(Math.PI * 0.25 + lat * DEGRAD * 0.5);
  ra = (re * sf) / Math.pow(ra, sn);
  let theta = lon * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2.0 * Math.PI;
  if (theta < -Math.PI) theta += 2.0 * Math.PI;
  theta *= sn;

  return {
    nx: Math.floor(ra * Math.sin(theta) + ORIGIN_X + 0.5),
    ny: Math.floor(ro - ra * Math.cos(theta) + ORIGIN_Y + 0.5),
  };
}

/**
 * 상품의 대표 지점 하나를 고른다 (EI-WX-002).
 *
 * 일정 항목마다 조회하지 않는다. 5km 격자라 같은 도시 안 관광지는 대개 같은 격자에
 * 떨어지고, 항목별로 부르면 호출만 늘고 답은 같다.
 *
 * 좌표가 있는 항목들의 **평균**을 쓴다. 첫 항목을 쓰면 그 하나가 외곽이면 온 상품이
 * 엉뚱한 격자를 본다. 좌표가 하나도 없으면 `null` 이고 R09 는 확인 불가로 남는다.
 */
export function representativePoint(
  items: readonly { readonly mapX: number | null; readonly mapY: number | null }[],
): { readonly lon: number; readonly lat: number } | null {
  const located = items.filter(
    (i): i is { mapX: number; mapY: number } =>
      i.mapX !== null && i.mapY !== null && Number.isFinite(i.mapX) && Number.isFinite(i.mapY),
  );
  if (located.length === 0) return null;
  const lon = located.reduce((s, i) => s + i.mapX, 0) / located.length;
  const lat = located.reduce((s, i) => s + i.mapY, 0) / located.length;
  return { lon, lat };
}
