import { describe, expect, it } from "vitest";
import { daySpan } from "./day-summary";

describe("일차 요약의 시간 범위 (UI-S2-025 · #730)", () => {
  it("처음 시작 ~ 마지막 종료", () => {
    expect(daySpan([{ start: "10:00", end: "11:00" }, { start: "09:00", end: "09:30" }, { start: "12:00", end: "13:30" }])).toBe("09:00 – 13:30");
  });

  it("🔴 종료를 안 적은 마지막 일정도 범위에 든다", () => {
    expect(daySpan([{ start: "09:00", end: "10:00" }, { start: "12:00", end: "13:30" }, { start: "14:30", end: null }])).toBe("09:00 – 14:30 이후");
  });

  it("종료 없는 일정이 중간에 있으면 마지막 종료가 끝이다", () => {
    expect(daySpan([{ start: "09:00", end: null }, { start: "12:00", end: "13:30" }])).toBe("09:00 – 13:30");
  });

  it("종료가 하나도 없어도 범위를 적는다. 시각이 없으면 적지 않는다", () => {
    expect(daySpan([{ start: "09:00", end: null }, { start: "15:00", end: null }])).toBe("09:00 – 15:00 이후");
    expect(daySpan([])).toBeNull();
    expect(daySpan([{ start: "", end: null }])).toBeNull();
  });
});
