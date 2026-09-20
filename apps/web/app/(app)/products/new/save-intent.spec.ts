import { describe, expect, it } from "vitest";
import { afterSaveHref, hasInput } from "./save-intent";
import type { Schedule } from "./types";

const EMPTY = {
  name: "",
  regnCode: "",
  startDate: "",
  nights: 0 as const,
  target: "",
  concept: "",
  headcount: "",
  transport: "CAR" as const,
  schedule: [[]] as Schedule,
};

describe("등록 화면에서 나가는 길 (#657)", () => {
  it("🔴 저장만 하면 기획 목록으로 간다", () => {
    // 장소 고르기로 끌려가지 않는다. 방금 만든 상품은 기획중으로 목록에 뜬다.
    expect(afterSaveHref("list", 12, null)).toBe("/planning");
    expect(afterSaveHref("list", 12, "AC")).toBe("/planning");
  });

  it("장소 고르기는 그 상품의 기획 화면으로, 고른 종류를 달고 간다", () => {
    expect(afterSaveHref("plan", 12, null)).toBe("/products/12/plan");
    expect(afterSaveHref("plan", 12, "AC")).toBe("/products/12/plan?openType=AC");
    expect(afterSaveHref("plan", null, null)).toBe("/");
  });

  it("🔴 한 칸이라도 채웠으면 취소가 묻는다", () => {
    expect(hasInput(EMPTY)).toBe(false);
    expect(hasInput({ ...EMPTY, name: "강릉 바다" })).toBe(true);
    expect(hasInput({ ...EMPTY, regnCode: "51" })).toBe(true);
    expect(hasInput({ ...EMPTY, startDate: "2026-10-01" })).toBe(true);
    expect(hasInput({ ...EMPTY, nights: 2 })).toBe(true);
    expect(hasInput({ ...EMPTY, target: "FAMILY" })).toBe(true);
    expect(hasInput({ ...EMPTY, concept: "HEALING" })).toBe(true);
    expect(hasInput({ ...EMPTY, headcount: "2" })).toBe(true);
    expect(hasInput({ ...EMPTY, transport: "PUBLIC_TRANSIT" })).toBe(true);
    expect(
      hasInput({ ...EMPTY, schedule: [[{ id: "a", start: "", end: "", place: "", itemType: "" }]] }),
    ).toBe(true);
  });

  it("공백만 친 상품명은 채운 것으로 보지 않는다", () => {
    expect(hasInput({ ...EMPTY, name: "  " })).toBe(false);
  });
});
