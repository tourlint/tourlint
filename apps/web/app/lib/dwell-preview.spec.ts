import { describe, expect, it } from "vitest";
import { DWELL_MINUTES_SEED } from "@tourlint/shared";
import { dwellDefault, dwellDefaultOf, dwellMinutes, endAfter } from "./dwell-preview";

describe("dwellMinutes — 엔진 resolveEndTime 과 같은 규칙 (FR-IN-011)", () => {
  it("숙박은 끝 시간을 채우지 않는다", () => {
    expect(dwellMinutes("LODGING", "AC01")).toBeNull();
    expect(dwellMinutes("LODGING", null)).toBeNull();
  });

  it("표에 없는 중분류와 분류 없는 줄은 90분이다 — 숙박이 아닌 줄의 AC 분류도 표에 없다", () => {
    expect(dwellMinutes("SIGHT", "ZZ99")).toBe(90);
    expect(dwellMinutes("SIGHT", null)).toBe(90);
    expect(dwellMinutes("SIGHT", "AC01")).toBe(90);
  });

  it("표에 있는 중분류는 그 값이다 (엔진 표와 같아야 한다)", () => {
    const anyKey = Object.keys(DWELL_MINUTES_SEED)[0] as string;
    expect(dwellMinutes("SIGHT", anyKey)).toBe(DWELL_MINUTES_SEED[anyKey]);
    expect(dwellMinutes("REST", "FD05")).toBe(60);
  });
});

describe("endAfter", () => {
  it("시작에 분을 더하고 자정에서 멈춘다", () => {
    expect(endAfter("09:30", 120)).toBe("11:30");
    expect(endAfter("23:30", 90)).toBe("24:00");
    expect(endAfter("", 90)).toBeNull();
  });
});

describe("dwellDefault — 채워질 시각 · 「기본값 적용」 (UI-S2-009 · 032)", () => {
  const line = { start: "09:30", end: null, itemType: "SIGHT", lcls2: "EX04", endFromDwell: false };

  it("🔴 끝 시간이 비면 채워질 시각을 미리 보인다 (예: 산사체험 120분 → 11:30)", () => {
    expect(dwellDefault(line)).toEqual({ minutes: 120, end: "11:30", preview: true });
  });

  it("🔴 끝 시각을 기본 체류시간으로 채운 줄은 그 분 수를 보인다", () => {
    expect(dwellDefault({ ...line, end: "11:30", endFromDwell: true })).toEqual({ minutes: 120, end: "11:30", preview: false });
  });

  it("직접 적은 끝 · 숙박 · 분류를 모르는 줄은 아무것도 짓지 않는다", () => {
    expect(dwellDefault({ ...line, end: "10:30" })).toBeNull();
    expect(dwellDefault({ ...line, itemType: "LODGING" })).toBeNull();
    expect(dwellDefault({ ...line, lcls2: undefined })).toBeNull();
  });

  it("🔴 고르는 중인 줄은 분류가 정해지지 않아 시각을 짓지 않는다 — 옛 응답(값 없음)도 같다", () => {
    const item = { start: "14:30", end: null, itemType: "SIGHT", matchStatus: "CONFIRMED", lcls2: "VE01", endTimeSource: "DWELL_DEFAULT" };
    expect(dwellDefaultOf(item)).toEqual({ minutes: 60, end: "15:30", preview: true });
    expect(dwellDefaultOf({ ...item, matchStatus: "PENDING" })).toBeNull();
    expect(dwellDefaultOf({ start: "14:30", end: null, itemType: "SIGHT", matchStatus: "CONFIRMED" })).toBeNull();
  });

  it("🔴 직접 정한 곳은 검수가 판정에서 빼므로 채울 시각 · 「기본값 적용」 을 짓지 않는다", () => {
    const excluded = { start: "14:00", end: null, itemType: "SIGHT", matchStatus: "EXCLUDED", lcls2: null, endTimeSource: "DWELL_DEFAULT" };
    expect(dwellDefaultOf(excluded)).toBeNull();
    // 걷기 길 — 넣을 때 끝을 90분으로 채웠어도 배지를 달지 않는다
    expect(dwellDefaultOf({ ...excluded, end: "15:30" })).toBeNull();
  });
});
