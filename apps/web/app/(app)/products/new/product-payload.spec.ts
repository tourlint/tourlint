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
      ["강릉 경포대", "TEXT"], ["세인트존스", "MANUAL"], ["주문진 등대", "PICKER"], ["초당할머니순두부", "MANUAL"],
    ]);
    // 장소 담기로 넣은 줄은 고른 곳으로 저장된다
    expect(items[2]).toHaveProperty("content.contentId", "126175");
  });

  it("시작 방식을 그대로 싣는다", () => {
    expect(buildPayload({ ...base, planOrigin: { startedBy: "TEXT" } }).planOrigin).toEqual({ startedBy: "TEXT" });
    expect(buildPayload(base).planOrigin).toBeNull();
  });
});
