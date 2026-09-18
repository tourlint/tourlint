import { matchApi } from "../../../lib/api";
import type { MatchedContent } from "./types";

/** 양쪽 좌표가 확인된 장소만 반경 검색에 사용한다. */
export function canAnchor(content: MatchedContent | null | undefined): boolean {
  return Boolean(content?.contentId && Number.isFinite(content.mapx) && Number.isFinite(content.mapy)
    && content.mapx !== null && content.mapy !== null
    && content.mapx > 0 && content.mapx <= 180 && content.mapy > 0 && content.mapy <= 90);
}

/** 지역 필터는 유지하고, 입력에 반복된 지역명과 복합 표기의 첫 장소명으로 한 번만 보완한다. */
export function fallbackPlaceKeyword(value: string, regionLabel: string): string {
  let keyword = value.trim();
  const aliases = [regionLabel.trim(), regionLabel.trim().replace(/(?:특별자치시|특별자치도|특별시|광역시|시|군|구|도)$/, "")]
    .filter(Boolean).sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    if (keyword.startsWith(alias + " ")) { keyword = keyword.slice(alias.length).trim(); break; }
  }
  return keyword.split(/[·/]/)[0].trim();
}

export async function searchSchedulePlaces(value: string, regnCd: string, signguCd: string | null, regionLabel: string,
  search = matchApi.search) {
  const keyword = value.trim();
  const result = await search(keyword, regnCd, signguCd);
  const fallback = fallbackPlaceKeyword(keyword, regionLabel);
  if (result.candidates.length > 0 || fallback === "" || fallback === keyword) return result;
  return search(fallback, regnCd, signguCd);
}
