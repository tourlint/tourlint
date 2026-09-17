// 지역 코드 → 이름 (UI-S7-014 · 카탈로그 ldong-codes). 관심 지역 · 새 소식 카드가 코드 대신
// 이름을 보이는 데 쓴다. 이름을 못 찾으면 코드를 그대로 둔다 — 지어내지 않는다.

export interface RegionNameMaps {
  /** 시도 코드 → 이름 */
  readonly regns: ReadonlyMap<string, string>;
  /** `${regnCd}:${signguCd}` → 시군구 이름 */
  readonly signgus: ReadonlyMap<string, string>;
}

export const EMPTY_REGION_NAMES: RegionNameMaps = { regns: new Map(), signgus: new Map() };

/**
 * "시도 시군구" 한 줄. 이름을 찾은 조각만 이름으로 바꾸고, 못 찾은 조각은 코드를 그대로 둔다.
 * 시군구가 없으면 시도만 적는다.
 */
export function regionLabel(maps: RegionNameMaps, regnCd: string, signguCd: string | null): string {
  const regn = maps.regns.get(regnCd) ?? regnCd;
  if (signguCd === null || signguCd === "") return regn;
  const signgu = maps.signgus.get(`${regnCd}:${signguCd}`) ?? signguCd;
  return `${regn} ${signgu}`;
}
