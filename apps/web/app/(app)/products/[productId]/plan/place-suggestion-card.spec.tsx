// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchApi, type PlaceSuggestions, type ProductItem } from "../../../../lib/api";
import { findForbidden } from "../../../../lib/screen-words";
import { PlaceSuggestionCard, cardItemIds } from "./place-suggestion-card";

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
