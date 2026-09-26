// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentApi, auditApi, matchApi, planApi, productApi, type ProductDetail, type ProductItem } from "../../../../lib/api";
import { PlanEditor } from "./plan-editor";

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const row = (over: Partial<ProductItem>): ProductItem => ({
  itemId: 1, seq: 1, start: "10:00", end: "11:30", place: "강릉 경포대", itemType: "SIGHT", ktoContentId: "125790",
  matchStatus: "CONFIRMED", mapx: null, mapy: null, lcls2: "HS01", endTimeSource: "INPUT", ...over,
});
const productWith = (items: ProductItem[]): ProductDetail => ({
  productId: 70, name: "강릉 감성 2박 3일", region: { regnName: "강원특별자치도", signguName: "강릉시" },
  ldongRegnCd: "51", ldongSignguCd: "150", startDate: "2026-11-17", nights: 0, dayCount: 1, plannedAt: null,
  composition: { manual: 0, picker: 0, excluded: 0 }, days: [{ day: 1, items }],
} as unknown as ProductDetail);

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.spyOn(auditApi, "availability").mockResolvedValue({ available: true, reasonCode: null, resumesAt: null });
  vi.spyOn(planApi, "placeFacts").mockResolvedValue({ items: [] });
  vi.spyOn(planApi, "briefing").mockResolvedValue({ region: { regnCd: "51", signguCd: "150", name: "강릉시" }, types: [], events: { count: 0, from: "2026-11-14", to: "2026-11-20" }, accessible: { count: 3 }, pet: { count: 1 }, walks: { count: 0 }, budget: "OK" });
  vi.spyOn(planApi, "events").mockResolvedValue({ window: { from: "2026-11-14", to: "2026-11-20" }, items: [] });
  vi.spyOn(planApi, "walks").mockResolvedValue({ items: [], notice: "" });
  vi.spyOn(matchApi, "search").mockResolvedValue({ regionFilterApplied: true, fetchedAt: "2026-09-26", candidates: [], totalCount: 0, source: "" });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const rowText = (place: string) => [...host.querySelectorAll("li.plan-timeline-item")].find((li) => li.textContent?.includes(place))?.textContent ?? "";

async function open(items: ProductItem[]) {
  vi.spyOn(productApi, "detail").mockResolvedValue(productWith(items));
  await act(async () => root.render(<PlanEditor productId={70} />));
  await settle();
}

describe("끝 시각 — 채워질 시각과 「기본값 적용」 (FR-IN-011 · UI-S2-009 · 032)", () => {
  it("🔴 끝 시간을 비운 고른 줄은 채워질 시각을 회색으로 보이고 분 수를 적는다", async () => {
    await open([row({ itemId: 5, place: "주문진 등대", start: "14:30", end: null, lcls2: "VE01", endTimeSource: "DWELL_DEFAULT" })]);
    const text = rowText("주문진 등대");
    expect(text).toContain("14:30 – 15:30");
    expect(text).toContain("기본값 적용 · 60분");
    expect(text).toContain("끝 시간을 비우면 보통 머무는 시간으로 채워요.");
    expect(host.querySelector(".plan-stop-end-preview")?.textContent).toBe("15:30");
  });

  it("🔴 장소 담기가 체류시간으로 채운 끝 시각에도 「기본값 적용」 을 붙인다", async () => {
    await open([row({ itemId: 6, place: "하슬라아트월드", start: "12:05", end: "13:35", lcls2: "VE07", endTimeSource: "DWELL_DEFAULT" })]);
    const text = rowText("하슬라아트월드");
    expect(text).toContain("12:05 – 13:35");
    expect(text).toContain("기본값 적용 · 90분");
    expect(text).not.toContain("끝 시간을 비우면");
  });

  it("직접 적은 끝 · 숙박 · 고르는 중인 줄에는 붙이지 않는다", async () => {
    await open([
      row({ itemId: 1, place: "강릉 경포대" }),
      row({ itemId: 2, seq: 2, place: "세인트존스 호텔", itemType: "LODGING", start: "18:00", end: null, lcls2: "AC01", endTimeSource: "DWELL_DEFAULT" }),
      row({ itemId: 3, seq: 3, place: "경포해변", matchStatus: "PENDING", ktoContentId: null, end: null, lcls2: null, endTimeSource: "DWELL_DEFAULT" }),
      // 걷기 길 — 직접 정한 곳이라 검수가 판정에서 뺀다
      row({ itemId: 4, seq: 4, place: "해파랑길 35코스", matchStatus: "EXCLUDED", ktoContentId: null, start: "14:00", end: "15:30", lcls2: null, endTimeSource: "DWELL_DEFAULT" }),
    ]);
    expect(host.textContent).not.toContain("기본값 적용");
    // 고르는 중인 줄은 분류를 몰라 시각은 짓지 않고 안내만 둔다
    expect(rowText("경포해변")).toContain("끝 시간을 비우면 보통 머무는 시간으로 채워요.");
  });
});

describe("고르지 않은 줄 (UI-S2-034 · UI-S2-023)", () => {
  const beach = row({ itemId: 5, place: "경포해변", matchStatus: "PENDING", ktoContentId: null, lcls2: null });
  const station = row({ itemId: 6, seq: 2, place: "강릉역", matchStatus: "PENDING", ktoContentId: null, lcls2: null, itemType: "MOVE" });
  const buttonsIn = (place: string, label: string) =>
    [...([...host.querySelectorAll("li.plan-timeline-item")].find((li) => li.textContent?.includes(place))?.querySelectorAll("button") ?? [])]
      .filter((b) => b.textContent === label);
  const click = async (label: string) => act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === label)!.click());

  it("🔴 줄 아래에는 「아직 고르지 않음」 과 두 버튼만 있고, 카드가 다루는 줄은 두 버튼을 숨긴다", async () => {
    vi.spyOn(agentApi, "placeSuggestions").mockResolvedValue({
      items: [{ itemId: 6, kind: "NOT_FOUND", place: null, alternatives: [], reason: "" }],
      summary: { found: 0, notFound: 1, noName: 0 },
      // 경포해변은 끝내지 못했다 — 카드에 없으니 줄에서 고른다 (EX-AG-002)
      incomplete: { reasonCode: "LLM_UNAVAILABLE", itemIds: [5] },
    });
    await open([beach, station]);
    await act(async () => { await new Promise((r) => setTimeout(r, 350)); });
    expect(rowText("경포해변")).toContain("아직 고르지 않음");
    expect(host.querySelector("li.plan-timeline-item input")).toBeNull();
    expect(buttonsIn("강릉역", "장소 찾기")).toHaveLength(1);

    await click("AI로 한 번에 찾기");
    expect(buttonsIn("강릉역", "장소 찾기")).toHaveLength(0);
    expect(buttonsIn("강릉역", "직접 정한 곳으로 두기")).toHaveLength(0);
    expect(buttonsIn("경포해변", "장소 찾기")).toHaveLength(1);
    expect(host.textContent).toContain("지금은 AI로 정리할 수 없어요");
  });

  it("🔴 검수 시작 창의 [AI로 한 번에 찾기]는 창을 닫고 같은 찾기를 돌린다", async () => {
    const suggest = vi.spyOn(agentApi, "placeSuggestions").mockResolvedValue({
      items: [{ itemId: 5, kind: "NOT_FOUND", place: null, alternatives: [], reason: "" }],
      summary: { found: 0, notFound: 1, noName: 0 }, incomplete: null,
    });
    await open([beach, station]);
    await click("검수 시작 →");
    expect(host.textContent).toContain("1일차 10:00 · 경포해변");
    await click("AI로 한 번에 찾기");
    expect(suggest).toHaveBeenCalledWith(70);
    expect(host.textContent).not.toContain("검수를 시작할까요?");
    expect(host.textContent).toContain("1곳은 못 찾았어요");
    // 카드 줄이 어느 일정 줄인지 — 편집기 줄은 「아직 고르지 않음」 만 남는다 (가이드 7-2)
    const cardRow = [...host.querySelectorAll("li")].find((li) => !li.classList.contains("plan-timeline-item") && li.textContent?.includes("찾지 못했어요"));
    expect(cardRow?.textContent).toContain("1일차 10:00 · 경포해변");
  });
});
