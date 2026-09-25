import type { RegionSignal } from "./api";

// 관심 지역 새 소식 판단. 레이더 지역 카드와 홈 보드 아래 바로 가기(UI-S1-012 · #804)가 같은 기준을 쓴다.

/** 이 지역에 지금 볼 소식이 있는가 — 행사 · 새로 등록된 곳 · 키워드와 맞는 곳 중 하나라도 */
export function hasRegionNews(s: RegionSignal): boolean {
  const hits = [...(s.t1?.keywordHits ?? []), ...(s.t2?.keywordHits ?? [])].some((h) => (h.contentIds?.length ?? 0) > 0);
  return (s.t1?.count ?? 0) > 0 || (s.t2?.count ?? 0) > 0 || hits;
}

/** 이 지역 · 달로 새 상품 기획 (UI-S7-015) */
export function regionPlanHref(s: RegionSignal): string {
  return `/products/new?regnCd=${s.region.regnCd}&signguCd=${s.region.signguCd ?? ""}&month=${s.month}&origin=SIGNAL`;
}
