/**
 * 기획 조회의 지역 이름과 걷기 길 지역 거르기.
 *
 * 두루누비 코스 목록에는 지역 조건이 없고 좌표도 없다 — 전국이 한 번에 오고 지역은 `sigun`
 * 글자(「강원 강릉시」처럼 **시도 약칭 + 시군구**)로만 알 수 있다 (EI-KT-025 · 2026.09.15 실호출).
 */

/**
 * 법정동 시도 코드 → 두루누비 `sigun` 이 쓰는 약칭.
 *
 * 전남광주통합특별시(12)는 「전남」으로 온다. 세종은 시도 코드가 다섯 자리(`36110`)이고
 * 시군구 단계가 없다.
 */
export const REGN_SHORT_NAME: Readonly<Record<string, string>> = {
  '11': '서울',
  '12': '전남',
  '26': '부산',
  '27': '대구',
  '28': '인천',
  '30': '대전',
  '31': '울산',
  '36110': '세종',
  '41': '경기',
  '43': '충북',
  '44': '충남',
  '47': '경북',
  '48': '경남',
  '50': '제주',
  '51': '강원',
  '52': '전북',
};

/**
 * 그 코스가 상품 지역의 것인가.
 *
 * 시군구가 있으면 시군구 이름으로 본다 — 같은 약칭을 쓰는 시도가 없어 이름만으로 갈린다.
 * 세종처럼 시군구가 없으면 시도 약칭으로 본다. 지역 이름을 모르면 거르지 않고 **아무것도
 * 넣지 않는다** — 전국 목록을 그대로 보이면 다른 지역 코스가 상품에 들어간다.
 */
export function isCourseInRegion(
  sigun: unknown,
  region: { readonly regnCd: string; readonly signguName: string | null },
): boolean {
  const text = String(sigun ?? '').trim();
  if (text === '') return false;
  if (region.signguName !== null && region.signguName !== '') return text.includes(region.signguName);
  const short = REGN_SHORT_NAME[region.regnCd];
  return short !== undefined && text.includes(short);
}
