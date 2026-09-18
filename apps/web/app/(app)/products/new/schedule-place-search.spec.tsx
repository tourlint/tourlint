import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ScheduleEditor } from "./schedule-editor";
import { canAnchor, searchSchedulePlaces } from "./schedule-place-search";
import type { ContentSearchResult } from "../../../lib/api";
import type { MatchedContent } from "./types";

const place: MatchedContent = { contentId: "test", contentTypeId: 12, mapx: 128.9, mapy: 37.8, lcls1: null, lcls2: null, lcls3: null };
const empty: ContentSearchResult = { candidates: [], regionFilterApplied: true, fetchedAt: "2026-09-18", totalCount: 0, source: "test" };
const found = { ...empty, candidates: [{ contentid: "test", title: "경포대", contenttypeid: 12, addr1: null, cpyrhtDivCd: null }], totalCount: 1 };

describe("가져온 일정의 근처 기준 선택", () => {
  it("자연어에서 가져온 미확정 행도 기준을 누를 수 있고 장소 확인을 제공한다", () => {
    const html = renderToStaticMarkup(<ScheduleEditor nights={0} regnCd="51" signguCd="150" regionLabel="강릉시"
      schedule={[[{ id: "up-1", start: "10:00", end: "11:30", place: "강릉 경포대", itemType: "SIGHT" }]]}
      onChange={() => {}} onAnchorChange={() => {}} />);
    const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];
    expect(checkbox).toBeDefined();
    expect(checkbox).not.toMatch(/\sdisabled(?:=|\s|>)/);
    expect(html).toContain("장소 확인");
    expect(html).toContain('value="10:00"');
    expect(html).toContain('value="11:30"');
  });

  it.each([null, undefined, { ...place, mapy: null }, { ...place, mapx: NaN }, { ...place, mapy: 0 }, { ...place, mapy: 100 }, { ...place, contentId: "" }])("좌표·식별자가 없는 장소를 기준으로 쓰지 않는다: %j", (value) => {
    expect(canAnchor(value)).toBe(false);
  });
  it("확인된 두 좌표가 있으면 기준으로 쓴다", () => expect(canAnchor(place)).toBe(true));

  it.each([["강릉 경포대", "경포대"], ["강릉 오죽헌·시립박물관", "오죽헌"]])("%s 검색 결과가 없으면 지역 필터를 유지한 채 %s로 한 번 보완한다", async (name, fallback) => {
    const search = vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce(found);
    expect(await searchSchedulePlaces(name, "51", "150", "강릉시", search)).toBe(found);
    expect(search.mock.calls).toEqual([[name, "51", "150"], [fallback, "51", "150"]]);
  });
  it("원문 검색 후보가 있으면 보완 호출을 하지 않는다", async () => {
    const search = vi.fn().mockResolvedValue(found);
    expect(await searchSchedulePlaces("강릉 경포대", "51", "150", "강릉시", search)).toBe(found);
    expect(search).toHaveBeenCalledTimes(1);
  });
  it("동일 검색어를 반복하지 않는다", async () => {
    const search = vi.fn().mockResolvedValue(empty);
    await searchSchedulePlaces("없는장소", "51", "150", "강릉시", search);
    expect(search).toHaveBeenCalledTimes(1);
  });
  it("공급자 오류를 빈 결과로 바꾸거나 다른 지역에서 다시 찾지 않는다", async () => {
    const search = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(searchSchedulePlaces("강릉 경포대", "51", "150", "강릉시", search)).rejects.toThrow("offline");
    expect(search).toHaveBeenCalledTimes(1);
  });
});
