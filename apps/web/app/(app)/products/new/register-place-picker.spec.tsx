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

  it("🔴 「자세히」에 폼의 타깃을 넘긴다 — 시니어는 무장애 편의가 앞 (UI-S2-040)", async () => {
    vi.spyOn(planApi, "briefing").mockResolvedValue(briefing());
    vi.spyOn(planApi, "placeDetail").mockResolvedValue({ contentId: "1", hours: "08:00~20:00", restDays: null, fee: null, parking: null, eventPeriod: null, contact: null, accessible: { wheelchair: "대여 가능" } });
    vi.spyOn(planApi, "places").mockResolvedValue({ ...cafes, items: [{ ...cafes.items[0]!, wheelchair: true }] });
    await act(async () => root.render(
      <RegisterPlacePicker regnCd="51" signguCd="150" startDate="2026-11-17" nights={2} regionLabel="강릉시" target="SENIOR" anchor={anchor} schedule={[[], [], []]} onInsert={() => {}} />,
    ));
    await settle();
    await act(async () => btn("카페")!.click());
    await settle();
    await act(async () => btn("자세히")!.click());
    await settle();
    const t = host.textContent ?? "";
    expect(t.indexOf("무장애 편의")).toBeGreaterThan(-1);
    expect(t.indexOf("무장애 편의")).toBeLessThan(t.indexOf("이용시간"));
  });
});

describe("등록 화면 장소 담기 — 행사 · 공연과 걷기 길 (UI-S2-048)", () => {
  const walk = { walkId: "T_CRS_MNG0000000402", name: "해파랑길 35코스 바우길 09구간", lengthKm: 10, minutes: 210, level: 2 as const };
  const renderWith = async (props: { onStartDateChange?: (d: string) => void; onInsertWalk?: (...a: unknown[]) => void } = {}) => {
    await act(async () => root.render(
      <RegisterPlacePicker regnCd="51" signguCd="150" startDate="2026-11-17" nights={1} regionLabel="강릉시" anchor={null}
        schedule={[[{ id: "it-1", start: "10:00", end: "11:30", place: "강릉 경포대", itemType: "SIGHT" }], []]} onInsert={() => {}}
        onStartDateChange={props.onStartDateChange ?? (() => {})} onInsertWalk={props.onInsertWalk ?? (() => {})} />,
    ));
    await settle();
  };
  const section = (title: string) => [...host.querySelectorAll("h3")].find((h) => h.textContent === title)?.parentElement ?? null;

  it("🔴 기획 화면과 같은 행사 카드 — 「출발일을 MM월 DD일로」 는 폼의 출발일을 바꾼다", async () => {
    vi.spyOn(planApi, "briefing").mockResolvedValue(briefing());
    vi.spyOn(planApi, "events").mockResolvedValue({ window: { from: "2026-11-14", to: "2026-11-21" }, items: [
      { contentId: "695592", contentTypeId: 15, title: "강릉 커피축제", eventStart: "2026-11-20", eventEnd: "2026-11-23", relation: "AFTER", suggestedStartDate: "2026-11-20", firstImage: null, mapx: null, mapy: null },
    ] });
    vi.spyOn(planApi, "walks").mockResolvedValue({ items: [], notice: "" });
    const move = vi.fn();
    await renderWith({ onStartDateChange: move });
    expect(section("행사 · 공연")?.textContent).toContain("강릉 커피축제2026-11-20 ~ 2026-11-23 · 여행 뒤에 열려요");
    await act(async () => btn("출발일을 11월 20일로")!.click());
    expect(move).toHaveBeenCalledWith("2026-11-20");
  });

  it("행사가 0건이면 한 줄로 적는다", async () => {
    vi.spyOn(planApi, "briefing").mockResolvedValue(briefing());
    vi.spyOn(planApi, "events").mockResolvedValue({ window: { from: "2026-11-14", to: "2026-11-21" }, items: [] });
    vi.spyOn(planApi, "walks").mockResolvedValue({ items: [], notice: "" });
    await renderWith();
    expect(section("행사 · 공연")?.textContent).toContain("여행 날짜 앞뒤 3일에 등록된 행사가 없어요");
  });

  it("🔴 걷기 길 [일정에 넣기]는 다른 카드처럼 일차 · 넣을 위치를 고른다", async () => {
    vi.spyOn(planApi, "briefing").mockResolvedValue(briefing());
    vi.spyOn(planApi, "events").mockResolvedValue({ window: { from: "2026-11-14", to: "2026-11-21" }, items: [] });
    vi.spyOn(planApi, "walks").mockResolvedValue({ items: [walk], notice: "" });
    const insert = vi.fn();
    await renderWith({ onInsertWalk: insert });
    const walks = section("걷기 길")!;
    expect(walks.textContent).toContain("해파랑길 35코스 바우길 09구간10km · 약 210분 · 난이도 2");
    expect(walks.textContent).toContain("넣으면 직접 정한 곳으로 들어가요.");
    await act(async () => [...walks.querySelectorAll("button")].find((b) => b.textContent === "일정에 넣기")!.click());
    const [daySelect, posSelect] = [...walks.querySelectorAll("select")];
    await act(async () => { posSelect!.value = "1"; posSelect!.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(daySelect!.value).toBe("0");
    await act(async () => [...walks.querySelectorAll("button")].find((b) => b.textContent === "여기에 넣기")!.click());
    expect(insert).toHaveBeenCalledWith(walk, 0, 1);
  });

  it("🔴 걷기 길 목록을 못 받으면 그 칸만 「지금은 볼 수 없어요」", async () => {
    vi.spyOn(planApi, "briefing").mockResolvedValue(briefing({ walks: null }));
    vi.spyOn(planApi, "events").mockResolvedValue({ window: { from: "2026-11-14", to: "2026-11-21" }, items: [] });
    vi.spyOn(planApi, "walks").mockResolvedValue({ items: [walk], notice: "" });
    await renderWith();
    expect(section("걷기 길")?.textContent).toContain("지금은 볼 수 없어요");
  });
});
