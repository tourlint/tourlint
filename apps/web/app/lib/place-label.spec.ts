import { describe, expect, it } from "vitest";
import { UNNAMED_PICKED, shownPlace } from "./place-label";

describe("이름을 불러오지 못한 고른 곳 (#908 · #911 리뷰)", () => {
  it("🔴 고른 곳인데 이름이 비었으면 그렇다고 적는다 — 저장 방식은 말하지 않는다 (UI-CM-040)", () => {
    expect(shownPlace({ place: "", matchStatus: "CONFIRMED" })).toBe("이름을 불러오지 못한 곳");
    expect(UNNAMED_PICKED).not.toMatch(/저장/);
  });

  it("이름이 있으면 그것, 고르지 않은 줄은 부르는 쪽 대체 표시를 쓴다", () => {
    expect(shownPlace({ place: " 경포대 ", matchStatus: "CONFIRMED" })).toBe("경포대");
    expect(shownPlace({ place: "", matchStatus: "PENDING" })).toBeNull();
  });
});
