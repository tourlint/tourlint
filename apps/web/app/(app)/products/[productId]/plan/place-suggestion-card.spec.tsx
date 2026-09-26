// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchApi, type PlaceSuggestions, type ProductItem } from "../../../../lib/api";
import { findForbidden } from "../../../../lib/screen-words";
import { PlaceSuggestionCard, cardItemIds } from "./place-suggestion-card";
import { lineLabel } from "./line-label";

const row = (itemId: number, place: string, over: Partial<ProductItem> = {}): ProductItem => ({
  itemId, seq: itemId, start: "09:00", end: "10:00", place, itemType: "SIGHT", ktoContentId: null,
  matchStatus: "PENDING", mapx: null, mapy: null, ...over,
});
const beach = row(5, "경포해변");
const station = row(6, "강릉역", { itemType: "MOVE" });
const lunch = row(7, "점심", { itemType: "MEAL" });
const suggestions = (over: Partial<PlaceSuggestions> = {}): PlaceSuggestions => ({
  items: [
    { itemId: 5, kind: "FOUND", place: { contentId: "128758", contentTypeId: 12, title: "경포해수욕장", kindName: "해수욕장", addr: null }, alternatives: [], reason: "이름이 같아요" },
    { itemId: 6, kind: "NOT_FOUND", place: null, alternatives: [], reason: "" },
    { itemId: 7, kind: "NO_NAME", place: null, alternatives: [], reason: "" },
  ],
  summary: { found: 1, notFound: 1, noName: 1 },
  incomplete: null,
  ...over,
});

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.spyOn(matchApi, "search").mockResolvedValue({ regionFilterApplied: true, fetchedAt: "", candidates: [], totalCount: 0, source: "" });
  vi.spyOn(matchApi, "exclude").mockResolvedValue({ itemId: 6, matchStatus: "EXCLUDED" });
  vi.spyOn(matchApi, "match").mockResolvedValue({} as Awaited<ReturnType<typeof matchApi.match>>);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 350)); });
const buttons = (label: string) => [...host.querySelectorAll("button")].filter((b) => b.textContent === label);
const render = (s: PlaceSuggestions, items = [beach, station, lunch], onResolved = async () => {}) =>
  act(async () => root.render(<PlaceSuggestionCard suggestions={s} items={items} regnCd="51" signguCd="150" regionLabel="강릉시" onResolved={onResolved} />));

describe("기획 에이전트 카드 — 어느 일정 줄인지 (#887 리뷰 · 가이드 7-2 · 7-3)", () => {
  // 기획 화면은 일차를 붙여 넘긴다 (withDays)
  const days = [{ ...beach, day: 2 }, { ...station, day: 3, start: "09:00" }, { ...lunch, day: 3, start: "12:30" }];
  const rowOf = (text: string) => [...host.querySelectorAll("li")].find((li) => li.textContent?.includes(text))!;
  const buttonsOf = (li: Element) => [...li.querySelectorAll("button")].map((b) => b.textContent);

  it("🔴 카드 줄마다 일차 · 시각 · 입력한 이름을 적는다 — AI 가 쓴 이유 문장에 기대지 않는다", async () => {
    await render(suggestions(), days);
    expect(rowOf("2일차 09:00 · 경포해변").textContent).toContain("경포해수욕장");
    expect(rowOf("3일차 09:00 · 강릉역").textContent).toContain("찾지 못했어요");
    expect(rowOf("3일차 12:30 · 점심").textContent).toContain("장소 이름이 없어요");
  });

  it("🔴 찾지 못한 줄에도 [장소 찾기]가 있다 — [직접 정한 곳으로 두기]와 함께 (UI-S2-044)", async () => {
    await render(suggestions(), days);
    expect(buttonsOf(rowOf("3일차 09:00 · 강릉역"))).toEqual(["직접 정한 곳으로 두기", "장소 찾기"]);
    expect(buttonsOf(rowOf("2일차 09:00 · 경포해변"))).toEqual(["이곳으로 선택", "장소 찾기"]);
    expect(buttonsOf(rowOf("3일차 12:30 · 점심"))).toEqual(["장소 찾기"]);
  });

  it("[장소 찾기]로 칸을 연 동안에도 어느 줄인지 남긴다", async () => {
    await render(suggestions(), days);
    const find = [...rowOf("강릉역").querySelectorAll("button")].find((b) => b.textContent === "장소 찾기")!;
    await act(async () => find.click());
    expect(rowOf("3일차 09:00 · 강릉역").querySelector("input")).not.toBeNull();
  });

  it("일차를 모르면 시각 · 이름만, 이름이 없으면 「이름 없는 줄」", () => {
    expect(lineLabel({ start: "09:00", place: "강릉역" })).toBe("09:00 · 강릉역");
    expect(lineLabel({ day: 1, start: "18:00", place: "  " })).toBe("1일차 18:00 · 이름 없는 줄");
  });
});

describe("기획 에이전트 카드 — 편집기 줄에서 숨긴 버튼을 카드에 둔다 (UI-S2-034 · UI-S2-044)", () => {
  it("🔴 찾지 못한 줄은 [직접 정한 곳으로 두기]로 바로 둔다", async () => {
    const resolved = vi.fn(async () => {});
    await render(suggestions(), [beach, station, lunch], resolved);
    expect(buttons("직접 정한 곳으로 두기")).toHaveLength(1);
    await act(async () => buttons("직접 정한 곳으로 두기")[0]!.click());
    expect(matchApi.exclude).toHaveBeenCalledWith(6);
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it("🔴 찾은 줄에도 [장소 찾기]가 있다 — 다른 곳을 직접 고를 길", async () => {
    await render(suggestions());
    expect(buttons("장소 찾기")).toHaveLength(3);
  });

  it("🔴 하나를 고른 뒤에도 남은 줄의 버튼은 눌린다", async () => {
    await render(suggestions());
    await act(async () => buttons("이곳으로 선택")[0]!.click());
    expect(buttons("직접 정한 곳으로 두기")[0]?.disabled).toBe(false);
  });

  it("🔴 이름이 없다고 본 줄의 [장소 찾기]는 그 문구로 검색하지 않고 빈 칸 · 안내로 연다 (UI-S2-045)", async () => {
    await render(suggestions());
    await act(async () => buttons("장소 찾기")[2]!.click());
    await settle();
    const input = host.querySelector("input")!;
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(matchApi.search).not.toHaveBeenCalled();
    expect(host.textContent).toContain("식당 이름을 적어 보세요 · 이름을 모르면 오른쪽 장소 담기에서 근처 식당을 골라 보세요");
  });

  it("카드가 다루는 줄은 응답에 있고 아직 고르지 않은 줄이다", () => {
    const done = { ...station, matchStatus: "EXCLUDED" };
    expect([...cardItemIds(suggestions(), [beach, done, lunch])]).toEqual([5, 7]);
    expect(cardItemIds(null, [beach]).size).toBe(0);
  });
});

describe("AI 가 끝내지 못했을 때 (FR-AG-005 · EX-AG-001 · 002)", () => {
  it("🔴 한 곳도 못 끝냈으면 카드를 없애지 않고 「지금은 AI로 정리할 수 없어요」 와 까닭을 적는다", async () => {
    await render(suggestions({ items: [], summary: { found: 0, notFound: 0, noName: 0 }, incomplete: { reasonCode: "LLM_UNAVAILABLE", itemIds: [5, 6] } }));
    expect(host.textContent).toContain("지금은 AI로 정리할 수 없어요 · AI 응답을 제때 받지 못했어요.");
    expect(host.textContent).not.toContain("찾지 못했어요");
    expect(findForbidden(host.innerHTML, true)).toEqual([]);
  });

  it("🔴 일부만 끝났으면 끝난 줄만 보이고 예산 까닭을 적는다", async () => {
    const partial = suggestions({ items: [suggestions().items[0]!], incomplete: { reasonCode: "BUDGET_EXHAUSTED", itemIds: [6] } });
    await render(partial);
    expect(host.textContent).toContain("오늘 쓸 수 있는 관광정보 조회를 다 써서 끝까지 찾지 못했어요. 끝난 곳만 보여 드려요.");
    expect(host.textContent).toContain("경포해수욕장");
    expect(host.textContent).not.toContain("강릉역");
    // 끝나지 않은 줄은 카드가 다루지 않는다 — 편집기 줄에서 고른다
    expect([...cardItemIds(partial, [beach, station])]).toEqual([5]);
  });

  it("끝나지 않은 줄을 사람이 다 골랐으면 까닭도 거둔다", async () => {
    await render(suggestions({ items: [], incomplete: { reasonCode: "LLM_UNAVAILABLE", itemIds: [6] } }), [beach, { ...station, matchStatus: "EXCLUDED" }]);
    expect(host.innerHTML).toBe("");
  });
});

describe("찾은 곳 카드 (UI-S2-044)", () => {
  const withAlternatives = suggestions({
    items: [{
      itemId: 5, kind: "FOUND",
      place: { contentId: "128758", contentTypeId: 12, title: "경포해수욕장", kindName: "해수욕장", addr: "강원특별자치도 강릉시 창해로 514" },
      alternatives: [
        { contentId: "2711001", title: "경포호수광장", kindName: "공원", distanceM: 1200 },
        { contentId: "2711002", title: "경포 해변 산책로", kindName: "자연경관", distanceM: null },
      ],
      reason: "이름이 같은 해수욕장이에요",
    }],
    summary: { found: 1, notFound: 0, noName: 0 },
  });
  const rowOf = (text: string) => [...host.querySelectorAll("li")].find((li) => li.textContent?.includes(text))!;

  it("🔴 「이곳이 맞나요?」 · 이름 · 종류 · 주소와 고른 이유를 보인다", async () => {
    await render(withAlternatives, [beach]);
    const text = rowOf("경포해수욕장").textContent ?? "";
    expect(text).toContain("이곳이 맞나요? 경포해수욕장");
    expect(text).toContain("해수욕장 · 강원특별자치도 강릉시 창해로 514");
    expect(text).toContain("이름이 같은 해수욕장이에요");
  });

  it("🔴 [다른 곳 N곳 보기]로 응답의 다른 후보를 펼치고 고르면 그곳으로 정한다", async () => {
    await render(withAlternatives, [beach]);
    expect(host.textContent).not.toContain("경포호수광장");
    await act(async () => buttons("다른 곳 2곳 보기")[0]!.click());
    expect(host.textContent).toContain("경포호수광장공원 · 직선 1.2km");
    expect(host.textContent).toContain("경포 해변 산책로자연경관");
    const alt = [...host.querySelectorAll('ul[aria-label="다른 곳"] li')].find((li) => li.textContent?.includes("경포호수광장"))!;
    await act(async () => [...alt.querySelectorAll("button")].find((b) => b.textContent === "이곳으로 선택")!.click());
    expect(matchApi.match).toHaveBeenCalledWith(5, "2711001", "AGENT");
    expect(findForbidden(host.innerHTML, true)).toEqual([]);
  });

  it("다른 후보가 없으면 그 버튼을 두지 않는다", async () => {
    await render(suggestions(), [beach, station, lunch]);
    expect(host.textContent).not.toContain("다른 곳");
  });
});
