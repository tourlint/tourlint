/**
 * 평년 강수일수 표의 **시도 대표 지점** (EI-WX-004 · FR-RU-091 D+11 이상).
 *
 * `climate_normal` 은 `(ldong_regn_cd, month)` 하나에 한 행이라 시도마다 지점을 하나만
 * 고를 수 있다. 그 선택이 곧 그 시도 상품의 강수 판정 기준이 된다.
 *
 * 고른 기준 — **기상청이 전국 · 지역별 통계 산출에 쓰는 62개 지점** 중 그 시도를 대표하는
 * 곳. 목록은 기상자료개방포털 기후통계분석 > 기상현상일수 화면의 「전국/지역별 통계 산출
 * 지점 정보」에 있다. 평년값(1991~2020)이 30년 연속으로 있어야 하므로 신설 지점은 쓸 수 없다.
 *
 * ⚠️ **강원은 영동 · 영서의 강수량이 크게 다르다** — 평년 강수량이 각각 2,058.5mm ·
 *    1,690.3mm 다. 시도 한 행으로는 둘 중 하나만 담긴다. 강릉(영동)을 고른 것은 확정
 *    범위의 상품과 회귀 픽스처가 전부 강릉이기 때문이고, **영서 상품에는 과대 평가**가 된다.
 *    시군구 단위로 나누려면 `climate_normal` 스키마부터 바뀌어야 한다 (DB 명세서 개정 필요).
 *
 * 지점명은 판정 문장에 그대로 들어간다 — 「평년 기준 — 9월 강릉 강수일수 9.2일 (30%)」
 * (FR-RU-092).
 */

export interface ClimateStation {
  /** 기상청 지점번호 (ASOS `stnId`) */
  readonly stnId: number;
  /** 판정 문장에 들어가는 지점명 */
  readonly name: string;
}

export const CLIMATE_STATION: Readonly<Record<string, ClimateStation>> = {
  '11': { stnId: 108, name: '서울' },
  '26': { stnId: 159, name: '부산' },
  '27': { stnId: 143, name: '대구' },
  '28': { stnId: 112, name: '인천' },
  '29': { stnId: 156, name: '광주' },
  '30': { stnId: 133, name: '대전' },
  '31': { stnId: 152, name: '울산' },
  // 세종은 종관 지점이 늦게 생겨 평년값 30년이 없다. 인접한 대전을 대표로 쓴다
  '36': { stnId: 133, name: '대전' },
  '41': { stnId: 119, name: '수원' },
  // 강원 — 영동 기준이다. 위 경고 참조
  '42': { stnId: 105, name: '강릉' },
  '51': { stnId: 105, name: '강릉' },
  '43': { stnId: 131, name: '청주' },
  '44': { stnId: 232, name: '천안' },
  '45': { stnId: 146, name: '전주' },
  '52': { stnId: 146, name: '전주' },
  '46': { stnId: 165, name: '목포' },
  // 전남광주통합특별시 — 공사 시도 목록 실측 코드 (EI-KT-014). 광주와 같은 지점을 쓴다
  '12': { stnId: 156, name: '광주' },
  // 전남광주통합특별시 — 공사 시도 목록 실측 코드 (EI-KT-014). 광주와 같은 지점을 쓴다

  '47': { stnId: 136, name: '안동' },
  '48': { stnId: 155, name: '창원' },
  '50': { stnId: 184, name: '제주' },
};

/** 그 시도의 대표 지점. 없으면 `null` 이고 R09 는 평년 판정을 하지 않는다 */
export function climateStationOf(ldongRegnCd: string | null): ClimateStation | null {
  if (ldongRegnCd === null) return null;
  return CLIMATE_STATION[ldongRegnCd.trim()] ?? null;
}

/** 평년 기간. 저장·표기에 함께 쓴다 (EI-WX-004) */
export const CLIMATE_NORMAL_PERIOD = '1991-2020';
export const CLIMATE_SOURCE_NOTE = '출처: 기상청 기상자료개방포털';
