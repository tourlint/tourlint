/**
 * 중기육상예보 예보구역 코드 (`regId`) 매핑.
 *
 * 중기예보는 격자가 아니라 **예보구역**으로 조회한다. 단기예보의 `nx` · `ny` 와 달리
 * 좌표에서 계산할 수 없어 표가 필요하다.
 *
 * 구역은 10개뿐이라 여러 시도가 한 구역을 함께 쓴다 — 서울 · 인천 · 경기가 `11B00000`
 * 하나다. 반대로 **강원만 영서 · 영동 둘로 갈린다.** 태백산맥이 날씨를 가르기 때문이고,
 * 강릉(영동)과 춘천(영서)에 같은 강수확률을 쓰면 R09 가 통째로 틀린다.
 *
 * **순수 함수다.**
 */

export const MID_LAND_REGION = {
  /** 서울 · 인천 · 경기 */
  SEOUL_INCHEON_GYEONGGI: '11B00000',
  /** 강원도영서 */
  GANGWON_YEONGSEO: '11D10000',
  /** 강원도영동 */
  GANGWON_YEONGDONG: '11D20000',
  /** 대전 · 세종 · 충남 */
  DAEJEON_SEJONG_CHUNGNAM: '11C20000',
  /** 충북 */
  CHUNGBUK: '11C10000',
  /** 광주 · 전남 */
  GWANGJU_JEONNAM: '11F20000',
  /** 전북 */
  JEONBUK: '11F10000',
  /** 대구 · 경북 */
  DAEGU_GYEONGBUK: '11H10000',
  /** 부산 · 울산 · 경남 */
  BUSAN_ULSAN_GYEONGNAM: '11H20000',
  /** 제주도 */
  JEJU: '11G00000',
} as const;

export type MidLandRegionId = (typeof MID_LAND_REGION)[keyof typeof MID_LAND_REGION];

/**
 * 법정동 시도 코드 → 예보구역.
 *
 * `12 전남광주통합특별시` 는 공사 시도 목록에서 실제로 관측된 코드다 (EI-KT-014,
 * 2026.08.20 실측). 광주 · 전남 구역에 넣는다.
 *
 * 강원(`42` · `51`)과 전북(`45` · `52`)은 특별자치도 전환 전후 코드가 둘 다 돌아다녀
 * 양쪽을 다 받는다. 강원은 여기서 값을 주지 않고 시군구로 갈린다.
 */
const BY_SIDO: Readonly<Record<string, MidLandRegionId>> = {
  '11': MID_LAND_REGION.SEOUL_INCHEON_GYEONGGI, // 서울특별시
  '28': MID_LAND_REGION.SEOUL_INCHEON_GYEONGGI, // 인천광역시
  '41': MID_LAND_REGION.SEOUL_INCHEON_GYEONGGI, // 경기도
  '43': MID_LAND_REGION.CHUNGBUK, // 충청북도
  '30': MID_LAND_REGION.DAEJEON_SEJONG_CHUNGNAM, // 대전광역시
  '36': MID_LAND_REGION.DAEJEON_SEJONG_CHUNGNAM, // 세종특별자치시
  '44': MID_LAND_REGION.DAEJEON_SEJONG_CHUNGNAM, // 충청남도
  '45': MID_LAND_REGION.JEONBUK, // 전라북도
  '52': MID_LAND_REGION.JEONBUK, // 전북특별자치도
  '29': MID_LAND_REGION.GWANGJU_JEONNAM, // 광주광역시
  '46': MID_LAND_REGION.GWANGJU_JEONNAM, // 전라남도
  '12': MID_LAND_REGION.GWANGJU_JEONNAM, // 전남광주통합특별시
  '27': MID_LAND_REGION.DAEGU_GYEONGBUK, // 대구광역시
  '47': MID_LAND_REGION.DAEGU_GYEONGBUK, // 경상북도
  '26': MID_LAND_REGION.BUSAN_ULSAN_GYEONGNAM, // 부산광역시
  '31': MID_LAND_REGION.BUSAN_ULSAN_GYEONGNAM, // 울산광역시
  '48': MID_LAND_REGION.BUSAN_ULSAN_GYEONGNAM, // 경상남도
  '50': MID_LAND_REGION.JEJU, // 제주특별자치도
};

const GANGWON_SIDO = new Set(['42', '51']);

/**
 * 강원 영동에 속하는 시군구 (법정동 뒤 3자리).
 *
 * **태백(190)이 영동인 근거** — 기상자료개방포털 기후통계분석 > 기상현상일수 화면의
 * 「전국/지역별 통계 산출 지점 정보」가 기상청 자신의 지역 구분을 적어 둔다.
 *
 *   강원영동: 속초(90), 강릉(105), 태백(216)
 *   강원영서: 철원(95), 대관령(100), 춘천(101), 원주(114), 인제(211), 홍천(212)
 *
 * 태백산맥 위에 있어 지리로는 갈리지 않고, 세부 예보구역 코드의 `11D2` 접두만으로는
 * 근거가 약해 한동안 확인 불가로 뒀던 곳이다 (2026.08.26).
 *
 * ⚠️ 위 목록은 **기후통계 지역 구분**이고 우리가 조회하는 것은 **중기육상예보 구역**이다.
 *    구역 이름(강원영동 · 강원영서)이 같고 발표 기관도 같아 그대로 따랐다. 정본인
 *    공공데이터포털 「중기예보 조회서비스」 활용가이드 zip 의 예보구역 코드표를 보면
 *    확정된다.
 */
const YEONGDONG_SIGNGU = new Set([
  '150', // 강릉시
  '170', // 동해시
  '190', // 태백시
  '210', // 속초시
  '230', // 삼척시
  '820', // 고성군
  '830', // 양양군
]);

/**
 * 상품 지역 → 예보구역. 모르면 `null` 이고 R09 는 그 상품을 확인 불가로 남긴다.
 *
 * **가까운 구역으로 대신 넣지 않는다.** 지어낸 구역의 강수확률로 「우천 위험 없음」을
 * 말하는 것이 확인 불가보다 나쁘다 (설계 원칙 3 · FR-RU-051).
 */
export function midLandRegionOf(ldongRegnCd: string | null, ldongSignguCd: string | null): MidLandRegionId | null {
  if (ldongRegnCd === null) return null;
  const sido = ldongRegnCd.trim();
  if (sido === '') return null;

  if (GANGWON_SIDO.has(sido)) {
    const signgu = normalizeSigngu(sido, ldongSignguCd);
    // 시군구를 모르면 영서·영동을 고를 근거가 없다
    if (signgu === null) return null;
    return YEONGDONG_SIGNGU.has(signgu) ? MID_LAND_REGION.GANGWON_YEONGDONG : MID_LAND_REGION.GANGWON_YEONGSEO;
  }

  return BY_SIDO[sido] ?? null;
}

/**
 * 시군구 코드를 뒤 3자리로 맞춘다.
 *
 * 공사 `ldongCode2` 는 시군구를 3자리(`150` 강릉)로 주지만, 저장된 값이 시도까지 붙은
 * 5자리(`51150`)일 수 있다. **길이를 가정하지 않는다** (DR-IN-010).
 */
function normalizeSigngu(sido: string, raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const bare = trimmed.startsWith(sido) && trimmed.length > sido.length ? trimmed.slice(sido.length) : trimmed;
  return bare.length >= 3 ? bare.slice(-3) : bare.padStart(3, '0');
}
