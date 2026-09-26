// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentApi, itemApi, matchApi, planApi, productApi, type ContentDetail, type ContentSearchResult, type ProductDetail, type ProductItem } from "../../../../lib/api";
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

describe("편집 화면 — 장소 담기의 걷기 길 (UI-S2-048)", () => {
  it("🔴 걷기 길을 넣고 시각을 적어 저장하면 식별자와 그 시각으로 넣는다 — 코스 이름은 보내지 않는다", async () => {
    vi.spyOn(productApi, "detail").mockResolvedValue(product([row({ matchStatus: "CONFIRMED", ktoContentId: "125790", place: "경포대", itemType: "SIGHT" })]));
    vi.spyOn(planApi, "briefing").mockResolvedValue({ region: { regnCd: "51", signguCd: "150", name: "강릉시" }, types: [], events: null, accessible: null, pet: null, walks: { count: 1 }, budget: "OK" });
    vi.spyOn(planApi, "walks").mockResolvedValue({ items: [{ walkId: "T_CRS_MNG0000000402", name: "해파랑길 35코스 바우길 09구간", lengthKm: 10, minutes: 210, level: 2 }], notice: "" });
    const addWalk = vi.spyOn(itemApi, "addWalk").mockResolvedValue({ itemId: 13 } as ProductItem);
    const add = vi.spyOn(itemApi, "add");
    const reorder = vi.spyOn(itemApi, "reorder").mockResolvedValue(undefined);
    await act(async () => root.render(<EditForm productId={70} />));
    await settle();
    const walks = [...host.querySelectorAll("h3")].find((h) => h.textContent === "걷기 길")!.parentElement!;
    await act(async () => [...walks.querySelectorAll("button")].find((b) => b.textContent === "일정에 넣기")!.click());
    const pos = [...walks.querySelectorAll("select")][1]!;
    await act(async () => { pos.value = "1"; pos.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => [...walks.querySelectorAll("button")].find((b) => b.textContent === "여기에 넣기")!.click());
    expect(host.textContent).toContain("해파랑길 35코스 바우길 09구간");
    const start = [...host.querySelectorAll("input")].filter((i) => i.type === "time").at(-2)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(start, "12:30");
    await act(async () => start.dispatchEvent(new Event("input", { bubbles: true })));
    await act(async () => button("저장")!.click());
    await settle();
    expect(addWalk).toHaveBeenCalledWith(70, { dayNo: 1, walkId: "T_CRS_MNG0000000402", startTime: "12:30", endTime: "" });
    expect(add).not.toHaveBeenCalled();
    expect(reorder).toHaveBeenCalledWith(70, [{ itemId: 11, dayNo: 1, seq: 1 }, { itemId: 13, dayNo: 1, seq: 2 }]);
  });
});

/** 가이드 1 ~ 8단계를 마친 상품 — 1일차 5개 · 2일차 6개 · 3일차 4개 (docs/judge-guide 9단계) */
function guideProduct(): ProductDetail {
  const at = (itemId: number, seq: number, place: string, start: string, end: string | null, itemType: string, over: Partial<ProductItem> = {}) =>
    row({ itemId, seq, place, start, end, itemType, matchStatus: "CONFIRMED", ktoContentId: String(itemId * 10), ...over });
  return {
    ...product([]), productId: 38, name: "강릉 감성 2박 3일", nights: 2, dayCount: 3,
    days: [
      { day: 1, items: [
        at(101, 1, "강릉 경포대", "10:00", "11:30", "SIGHT"), at(102, 2, "강릉 오죽헌·시립박물관", "11:00", "12:30", "SIGHT"),
        at(103, 3, "가람집옹심이", "13:00", "14:00", "MEAL"), at(104, 4, "강릉 경포벚꽃축제", "15:00", "16:00", "SIGHT"),
        at(105, 5, "하이오션 경포", "16:04", null, "LODGING"),
      ] },
      { day: 2, items: [
        at(201, 1, "경포해변", "09:00", "10:00", "SIGHT"), at(202, 2, "안목해변", "10:00", "11:00", "SIGHT"),
        at(203, 3, "정동진해변", "11:00", "12:00", "SIGHT"), at(204, 4, "하슬라아트월드", "12:05", "13:35", "SIGHT", { endTimeSource: "DWELL_DEFAULT" }),
        at(205, 5, "주문진해변", "16:00", "17:00", "SIGHT"), at(206, 6, "세인트존스 호텔", "18:00", null, "LODGING"),
      ] },
      { day: 3, items: [
        at(301, 1, "강릉역", "09:00", "09:30", "MOVE", { matchStatus: "EXCLUDED", ktoContentId: null }),
        at(302, 2, "초당할머니순두부", "12:30", "13:30", "MEAL"),
        at(303, 3, "주문진 등대", "14:30", null, "SIGHT", { endTimeSource: "DWELL_DEFAULT" }),
        at(304, 4, "해파랑길 35코스 바우길 09구간", "14:30", "15:30", "SIGHT",
          { matchStatus: "EXCLUDED", ktoContentId: null, walkId: "T_CRS_MNG0000000402", endTimeSource: "DWELL_DEFAULT" }),
      ] },
    ],
  } as ProductDetail;
}

const rows = () => [...host.querySelectorAll<HTMLButtonElement>('button[aria-label="위로"]')].map((b) => b.parentElement!.parentElement!);
const rowOf = (name: string) => rows().find((r) =>
  r.querySelector<HTMLInputElement>('input[aria-label="장소명"]')?.value === name || r.textContent?.includes(name))!;
const times = (r: HTMLElement) => [...r.querySelectorAll<HTMLInputElement>('input[type="time"]')];
async function type(el: HTMLInputElement, v: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
  await act(async () => el.dispatchEvent(new Event("input", { bubbles: true })));
}
const tab = (n: number) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent?.startsWith(`${n}일차`))!;

describe("편집 화면 — 가이드 9단계 · 불러온 걷기 길과 직접 정한 곳 (UI-S2-048 · UI-S2-021)", () => {
  it("🔴 하이오션 18:00 · 걷기 길 09:30 – 12:00 · ↑ 두 번 · 저장 — 걷기 길은 고칠 수 없는 줄로 열리고 코스 이름은 보내지 않는다", async () => {
    vi.spyOn(productApi, "detail").mockResolvedValue(guideProduct());
    const patch = vi.spyOn(itemApi, "patch").mockResolvedValue({} as ProductItem);
    const reorder = vi.spyOn(itemApi, "reorder").mockResolvedValue(undefined);
    const adds = [vi.spyOn(itemApi, "add"), vi.spyOn(itemApi, "addPicked"), vi.spyOn(itemApi, "addWalk")];
    const match = vi.spyOn(matchApi, "match");
    await act(async () => root.render(<EditForm productId={38} />));
    await settle(350);
    expect([1, 2, 3].map((n) => tab(n).textContent)).toEqual(["1일차(5)", "2일차(6)", "3일차(4)"]);

    // 1일차 — 하이오션 경포 시작을 18:00 으로
    await type(times(rowOf("하이오션 경포"))[0]!, "18:00");

    // 3일차 — 걷기 길 · 직접 정한 곳은 「직접 정한 곳」 으로 열린다. 이름 칸이 없고 기준으로 쓸 수 없다
    await act(async () => tab(3).click());
    await settle(350);
    const walk = rowOf("해파랑길 35코스 바우길 09구간");
    const station = rowOf("강릉역");
    for (const r of [walk, station]) {
      expect(r.textContent).toContain("직접 정한 곳");
      expect(r.querySelector('input[aria-label="장소명"]')).toBeNull();
      expect(r.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
      expect([...r.querySelectorAll("button")].some((b) => b.textContent === "다시 고르기")).toBe(false);
    }
    // 코스 이름 · 직접 정한 곳 이름으로 장소를 찾지 않는다
    const keywords = vi.mocked(matchApi.search).mock.calls.map((c) => c[0]);
    expect(keywords).not.toContain("해파랑길 35코스 바우길 09구간");
    expect(keywords).not.toContain("강릉역");

    // 걷기 길을 09:30 – 12:00 으로 바꾸고 ↑ 를 두 번 눌러 강릉역 다음으로
    await type(times(walk)[0]!, "09:30");
    await type(times(walk)[1]!, "12:00");
    await act(async () => rowOf("해파랑길 35코스 바우길 09구간").querySelector<HTMLButtonElement>('button[aria-label="위로"]')!.click());
    await act(async () => rowOf("해파랑길 35코스 바우길 09구간").querySelector<HTMLButtonElement>('button[aria-label="위로"]')!.click());
    expect(rows().map((r) => r.querySelector<HTMLInputElement>('input[aria-label="장소명"]')?.value ?? r.querySelector("span.truncate")?.textContent))
      .toEqual(["강릉역", "해파랑길 35코스 바우길 09구간", "초당할머니순두부", "주문진 등대"]);

    await act(async () => button("저장")!.click());
    await settle();
    expect(patch.mock.calls).toEqual([
      [105, { startTime: "18:00" }],
      [304, { startTime: "09:30", endTime: "12:00" }],
    ]);
    expect(reorder).toHaveBeenCalledWith(38, [
      ...[101, 102, 103, 104, 105].map((itemId, i) => ({ itemId, dayNo: 1, seq: i + 1 })),
      ...[201, 202, 203, 204, 205, 206].map((itemId, i) => ({ itemId, dayNo: 2, seq: i + 1 })),
      ...[301, 304, 302, 303].map((itemId, i) => ({ itemId, dayNo: 3, seq: i + 1 })),
    ]);
    for (const add of adds) expect(add).not.toHaveBeenCalled();
    expect(match).not.toHaveBeenCalled();
    expect(matchApi.exclude).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith("/products/38/plan");
  });
});

describe("편집 화면 — 불러온 줄에서 후보 고르기 (FR-IN-029 · UI-S2-025 · DR-PR-001)", () => {
  const found: ContentSearchResult = {
    regionFilterApplied: true, fetchedAt: "", totalCount: 1, source: "",
    candidates: [{ contentid: "2733968", title: "경포해수욕장", addr1: null, contenttypeid: 12, cpyrhtDivCd: null }],
  };
  async function open(name: string) {
    vi.spyOn(productApi, "detail").mockResolvedValue(product([row({ place: name, itemType: "SIGHT" })]));
    vi.spyOn(matchApi, "search").mockResolvedValue(found);
    vi.spyOn(contentApi, "detail").mockResolvedValue({ contentTypeId: 12, mapx: 128.9, mapy: 37.8, lclsSystm1: "NA", lclsSystm2: "NA04", lclsSystm3: null } as ContentDetail);
    await act(async () => root.render(<EditForm productId={70} />));
    await settle();
    await act(async () => rowOf(name).querySelector<HTMLInputElement>('input[aria-label="장소명"]')!.focus());
    await settle(350);
  }
  const pick = async (name: string) => { await act(async () => rowOf(name).querySelector<HTMLButtonElement>("li button")!.click()); await settle(); };

  it("🔴 고르는 중이던 줄에 후보를 고르면 저장할 때 확정한다 — 이름은 친 글 그대로다", async () => {
    await open("경포해변");
    const match = vi.spyOn(matchApi, "match").mockResolvedValue({} as Awaited<ReturnType<typeof matchApi.match>>);
    const patch = vi.spyOn(itemApi, "patch");
    await pick("경포해변");
    expect(rows()[0]!.textContent).toContain("✓");
    expect(rows()[0]!.textContent).toContain("경포해변");
    expect(host.textContent).not.toContain("경포해수욕장");
    await act(async () => button("저장")!.click());
    await settle();
    expect(match).toHaveBeenCalledWith(11, "2733968", "USER");
    expect(patch).not.toHaveBeenCalled();
    expect(matchApi.exclude).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith("/products/70/plan");
  });

  it("🔴 다른 이름으로 찾아 고르면 그 이름으로 바꾸고 확정한다 — 공식 명칭은 보내지 않는다", async () => {
    await open("경포해변");
    const match = vi.spyOn(matchApi, "match").mockResolvedValue({} as Awaited<ReturnType<typeof matchApi.match>>);
    const patch = vi.spyOn(itemApi, "patch").mockResolvedValue({} as ProductItem);
    await type(rowOf("경포해변").querySelector<HTMLInputElement>('input[aria-label="장소명"]')!, "경포 해수욕장");
    await settle(350);
    await pick("경포 해수욕장");
    await act(async () => button("저장")!.click());
    await settle();
    expect(patch.mock.calls).toEqual([[11, { placeLabel: "경포 해수욕장" }]]);
    expect(match).toHaveBeenCalledWith(11, "2733968", "USER");
  });
});

describe("편집 화면 — 고른 곳으로 넣은 새 줄의 시각 (FR-IN-014)", () => {
  it("🔴 장소 칸 후보로 고른 새 줄은 적은 시각으로 넣는다 — 앞 일정 끝으로 다시 채우지 않는다", async () => {
    vi.spyOn(productApi, "detail").mockResolvedValue(product([row({ matchStatus: "CONFIRMED", ktoContentId: "125790", place: "경포대", itemType: "SIGHT" })]));
    vi.spyOn(matchApi, "search").mockResolvedValue({
      regionFilterApplied: true, fetchedAt: "", totalCount: 1, source: "",
      candidates: [{ contentid: "126175", title: "주문진 등대", addr1: null, contenttypeid: 12, cpyrhtDivCd: null }],
    });
    vi.spyOn(contentApi, "detail").mockResolvedValue({ contentTypeId: 12, mapx: 128.83, mapy: 37.9, lclsSystm1: "VE", lclsSystm2: "VE01", lclsSystm3: null } as ContentDetail);
    vi.spyOn(itemApi, "reorder").mockResolvedValue(undefined);
    // 항목 추가 요청 본문을 본다 — 화면이 보낸 시각이 서버까지 가야 한다
    const sent: Record<string, unknown>[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/products/70/items" && init?.method === "POST") {
        sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ itemId: 12 }), { status: 201 });
      }
      return new Response(JSON.stringify({ message: "없는 경로" }), { status: 500 });
    }) as typeof fetch;
    try {
      await act(async () => root.render(<EditForm productId={70} />));
      await settle();
      await act(async () => button("+ 항목 추가")!.click());
      const added = rows().at(-1)!;
      await type(times(added)[0]!, "14:30");
      await type(times(added)[1]!, "15:45");
      const place = added.querySelector<HTMLInputElement>('input[aria-label="장소명"]')!;
      await type(place, "주문진 등대");
      await act(async () => place.focus());
      await settle(350);
      await act(async () => rows().at(-1)!.querySelector<HTMLButtonElement>("li button")!.click());
      await settle();
      const kind = rows().at(-1)!.querySelector("select")!;
      await act(async () => { kind.value = "SIGHT"; kind.dispatchEvent(new Event("change", { bubbles: true })); });
      await act(async () => button("저장")!.click());
      await settle();
      expect(sent).toEqual([expect.objectContaining({
        dayNo: 1, origin: "PICKER", content: expect.objectContaining({ contentId: "126175" }), startTime: "14:30", endTime: "15:45",
      })]);
      expect(router.push).toHaveBeenCalledWith("/products/70/plan");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
