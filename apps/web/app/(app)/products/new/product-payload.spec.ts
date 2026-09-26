import { describe, expect, it } from "vitest";
import { buildPayload, type PayloadInput } from "./product-payload";

const base: PayloadInput = {
  name: "강릉 감성 2박 3일", region: { regnCode: "51", signguCode: "150" }, startDate: "2026-11-17", nights: 0,
  target: "", concept: "", headcount: "", transport: "CAR",
  schedule: [[
    { id: "up-1-1", start: "10:00", end: "11:30", place: "강릉 경포대", itemType: "SIGHT", origin: "TEXT" },
    { id: "it-1", start: "18:00", end: "", place: "세인트존스", itemType: "LODGING", origin: "MANUAL" },
    { id: "pk-1", start: "14:30", end: "", place: "주문진 등대", itemType: "SIGHT", origin: "PICKER",
      content: { contentId: "126175", contentTypeId: 12, mapx: 128.8, mapy: 37.9, lcls1: "VE", lcls2: "VE01", lcls3: null } },
    // 경로를 모르는 줄(옛 초안)은 직접 입력으로 보낸다
    { id: "old-1", start: "12:30", end: "13:30", place: "초당할머니순두부", itemType: "MEAL" },
  ]],
};

describe("등록 저장 본문 — 줄이 들어온 경로 (FR-PL-020)", () => {
  it("🔴 줄마다 들어온 경로를 싣는다", () => {
    const items = buildPayload(base).days[0]?.items ?? [];
    expect(items.map((i) => [i.place, i.origin])).toEqual([
      ["강릉 경포대", "TEXT"], ["세인트존스", "MANUAL"], ["", "PICKER"], ["초당할머니순두부", "MANUAL"],
    ]);
    // 장소 담기로 넣은 줄은 고른 곳으로 저장된다
    expect(items[2]).toHaveProperty("content.contentId", "126175");
  });

  it("시작 방식을 그대로 싣는다", () => {
    expect(buildPayload({ ...base, planOrigin: { startedBy: "TEXT" } }).planOrigin).toEqual({ startedBy: "TEXT" });
    expect(buildPayload(base).planOrigin).toBeNull();
  });

  it("🔴 「직접 정한 곳으로 두기」를 고른 줄은 excluded 로 보낸다 — 관광지를 고른 줄은 보내지 않는다 (UI-S2-021)", () => {
    const items = buildPayload({ ...base, schedule: [[
      { id: "it-1", start: "09:00", end: "09:30", place: "강릉역", itemType: "MOVE", origin: "MANUAL", excluded: true },
      { ...base.schedule[0]![2]!, excluded: true },
      { id: "it-2", start: "10:00", end: "", place: "경포해변", itemType: "SIGHT", origin: "MANUAL" },
    ]] }).days[0]?.items ?? [];
    expect(items.map((i) => "excluded" in i ? i.excluded : undefined)).toEqual([true, undefined, undefined]);
  });

  it("🔴 걷기 길 줄은 식별자만 보낸다 — 칸에 보이는 코스 이름은 보내지 않는다 (DR-MD-005 · UI-S2-048)", () => {
    const payload = buildPayload({ ...base, schedule: [[
      { id: "wk-1", start: "09:30", end: "12:00", place: "해파랑길 35코스 바우길 09구간", itemType: "SIGHT", origin: "PICKER", walk: { walkId: "T_CRS_MNG0000000402" } },
    ]] });
    expect(payload.days[0]?.items[0]).toEqual({
      start: "09:30", end: "12:00", place: "", itemType: "SIGHT", excluded: { walkId: "T_CRS_MNG0000000402" }, origin: "PICKER",
    });
    expect(JSON.stringify(payload)).not.toContain("해파랑길");
  });

  it("🔴 관광지를 고른 줄은 칸에 보이는 공식 명칭을 보내지 않는다 — 서버가 표시할 때 찾는다 (DR-PR-001 · DR-IN-013)", () => {
    const picked = { contentId: "142785", contentTypeId: 32, mapx: 128.9, mapy: 37.8, lcls1: "AC", lcls2: "AC01", lcls3: null };
    const payload = buildPayload({ ...base, schedule: [[
      // 장소 칸에 「세인트존스」 를 치고 후보를 고르면 칸 이름이 공식 명칭으로 바뀐다 (UI-S2-020)
      { id: "it-1", start: "18:00", end: "", place: "세인트존스 호텔", itemType: "LODGING", origin: "MANUAL", content: picked },
      { ...base.schedule[0]![2]! },
    ]] });
    expect(payload.days[0]?.items.map((i) => i.place)).toEqual(["", ""]);
    expect(JSON.stringify(payload)).not.toContain("세인트존스");
    expect(JSON.stringify(payload)).not.toContain("주문진 등대");
  });
});
