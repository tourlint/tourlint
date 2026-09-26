// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { itemApi, matchApi, planApi, productApi, type ContentSearchResult, type ProductDetail, type ProductItem } from "../../../../lib/api";
import { EditForm } from "./edit-form";

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const row = (over: Partial<ProductItem>): ProductItem => ({
  itemId: 11, seq: 1, start: "09:00", end: "09:30", place: "강릉역", itemType: "MOVE", ktoContentId: null,
  matchStatus: "PENDING", mapx: null, mapy: null, lcls2: null, endTimeSource: "INPUT", ...over,
});
const product = (items: ProductItem[]): ProductDetail => ({
  productId: 70, name: "강릉 당일", region: { regnName: "강원특별자치도", signguName: "강릉시" }, ldongRegnCd: "51", ldongSignguCd: "150",
  startDate: "2026-11-17", nights: 0, dayCount: 1, targetKey: null, conceptKey: null, headCount: null, transport: "CAR",
  releasedAt: null, plannedAt: null, planOrigin: null, composition: { manual: 1, picker: 0, excluded: 0 }, days: [{ day: 1, items }],
} as ProductDetail);
const none: ContentSearchResult = { regionFilterApplied: true, fetchedAt: "", candidates: [], totalCount: 0, source: "" };

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  router.push.mockClear();
  vi.spyOn(matchApi, "search").mockResolvedValue(none);
  vi.spyOn(matchApi, "exclude").mockResolvedValue({ itemId: 11, matchStatus: "EXCLUDED" });
  vi.spyOn(planApi, "briefing").mockResolvedValue({ region: { regnCd: "51", signguCd: "150", name: "강릉시" }, types: [], events: null, accessible: null, pet: null, walks: null, budget: "OK" });
  vi.spyOn(planApi, "events").mockResolvedValue({ window: { from: "2026-11-14", to: "2026-11-20" }, items: [] });
  vi.spyOn(planApi, "walks").mockResolvedValue({ items: [], notice: "" });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const settle = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

async function excludeFirstRow() {
  const input = [...host.querySelectorAll("input")].find((i) => i.getAttribute("aria-label") === "장소명")!;
  await act(async () => input.focus());
  await settle(350);
  await act(async () => button("찾는 곳이 없나요? 직접 정한 곳으로 두기")!.click());
}

describe("편집 화면 — 「직접 정한 곳으로 두기」 (UI-S2-021)", () => {
  it("🔴 고르는 중이던 저장된 줄은 저장할 때 직접 정한 곳으로 바꾼다", async () => {
    vi.spyOn(productApi, "detail").mockResolvedValue(product([row({})]));
    await act(async () => root.render(<EditForm productId={70} />));
    await settle();
    await excludeFirstRow();
    expect(host.textContent).toContain("직접 정한 곳");
    await act(async () => button("저장")!.click());
    await settle();
    expect(matchApi.exclude).toHaveBeenCalledWith(11);
    expect(router.push).toHaveBeenCalledWith("/products/70/plan");
  });

  it("🔴 새로 넣은 줄은 직접 정한 곳으로 추가한다", async () => {
    vi.spyOn(productApi, "detail").mockResolvedValue(product([row({ matchStatus: "CONFIRMED", ktoContentId: "125790", place: "경포대", itemType: "SIGHT" })]));
    const add = vi.spyOn(itemApi, "add").mockResolvedValue({ itemId: 12 } as ProductItem);
    vi.spyOn(itemApi, "reorder").mockResolvedValue(undefined);
    await act(async () => root.render(<EditForm productId={70} />));
    await settle();
    // 저장된 고른 곳에는 그 선택지가 없다 — 여기서 바꿀 길이 없는데 누르게 두지 않는다
    await act(async () => [...host.querySelectorAll("input")].find((i) => i.getAttribute("aria-label") === "장소명")!.focus());
    await settle(350);
    expect(button("찾는 곳이 없나요? 직접 정한 곳으로 두기")).toBeUndefined();
    await act(async () => button("+ 항목 추가")!.click());
    const inputs = () => [...host.querySelectorAll("input")];
    const time = inputs().filter((i) => i.type === "time");
    const place = inputs().filter((i) => i.getAttribute("aria-label") === "장소명").at(-1)!;
    const setValue = async (el: HTMLInputElement, v: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
      await act(async () => el.dispatchEvent(new Event("input", { bubbles: true })));
    };
    await setValue(time.at(-2)!, "10:00");
    await setValue(place, "협력 공방");
    const type = [...host.querySelectorAll("select")].at(-1)!;
    await act(async () => { type.value = "SIGHT"; type.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => place.focus());
    await settle(350);
    await act(async () => [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "찾는 곳이 없나요? 직접 정한 곳으로 두기").at(-1)!.click());
    await act(async () => button("저장")!.click());
    await settle();
    expect(add).toHaveBeenCalledWith(70, expect.objectContaining({ placeLabel: "협력 공방", excluded: true }));
    expect(matchApi.exclude).not.toHaveBeenCalled();
  });
});
