// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planApi, type PlanBriefing, type PlanPlaces } from "../../../lib/api";
import { RegisterPlacePicker, type RegisterAnchor } from "./register-place-picker";

const briefing = (over: Partial<PlanBriefing> = {}): PlanBriefing => ({
  region: { regnCd: "51", signguCd: "150", name: "강릉시" }, budget: "OK",
  types: [{ kind: "LCLS2", lcls2: "VE01", nearKind: null, name: "랜드마크관광", count: 6, disabled: null }],
  events: null, accessible: { count: 30 }, pet: { count: 4 }, walks: { count: 2 }, ...over,
});
const cafes: PlanPlaces = {
  scope: { kind: "NEAR3KM", label: "넣을 위치 근처 3km" }, totalCount: 12, notice: null,
  items: [{ contentId: "1", contentTypeId: 39, lcls1: "FD", lcls2: "FD05", lcls2Name: "카페", title: "바다 카페", addr1: null, firstImage: null, mapx: 128.9, mapy: 37.8, distanceM: 300, togetherRank: null, wheelchair: null, pet: null, indoorOutdoor: null }],
};
const anchor: RegisterAnchor = { contentId: "142785", mapx: 128.9, mapy: 37.8, label: "세인트존스 호텔" };

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.spyOn(planApi, "places").mockResolvedValue(cafes);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const btn = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);
const render = async (a: RegisterAnchor | null = anchor) => {
  await act(async () => root.render(
    <RegisterPlacePicker regnCd="51" signguCd="150" startDate="2026-11-17" nights={2} regionLabel="강릉시" anchor={a} schedule={[[], [], []]} onInsert={() => {}} />,
  ));
  await settle();
};

describe("등록 화면 장소 담기 (UI-S2-036 · 037 · 038 · 043)", () => {
  it("🔴 「(시군구) 전체」 · 「(기준 줄) 근처 3km」 머리와 누른 칩의 개수 · 가까운 순 안내", async () => {
    vi.spyOn(planApi, "briefing").mockResolvedValue(briefing());
    await render();
    expect(host.textContent).toContain("강릉시 전체");
    expect(host.textContent).toContain("\"세인트존스 호텔\" 근처 3km");
    expect(host.textContent).toContain("식당 · 카페 · 숙소는 가까운 순으로 보여 드려요");
    await act(async () => btn("카페")!.click());
    await settle();
    expect(btn("카페12")).toBeDefined();
  });

  it("🔴 칸을 접고 펼친다 — 처음에는 펼쳐 둔다", async () => {
    vi.spyOn(planApi, "briefing").mockResolvedValue(briefing());
    await render();
    await act(async () => btn("접기")!.click());
    expect(host.textContent).not.toContain("랜드마크관광");
    await act(async () => btn("펼치기")!.click());
    expect(host.textContent).toContain("랜드마크관광");
  });

  it("🔴 반려동물 목록을 못 받으면 그 필터만 「지금은 볼 수 없어요」, 켠 필터는 「필터 끄기」 로 끈다", async () => {
    vi.spyOn(planApi, "briefing").mockResolvedValue(briefing({ pet: null }));
    await render();
    const label = (name: string) => [...host.querySelectorAll("label")].find((l) => l.textContent?.startsWith(name))!;
    expect(label("반려동물 동반").textContent).toContain("지금은 볼 수 없어요");
    expect(label("반려동물 동반").querySelector("input")!.disabled).toBe(true);
    await act(async () => label("실내만").querySelector("input")!.click());
    expect(btn("필터 끄기")).toBeDefined();
    await act(async () => btn("필터 끄기")!.click());
    expect(label("실내만").querySelector("input")!.checked).toBe(false);
  });
});
