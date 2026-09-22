import { describe, expect, it } from "vitest";
import { startDateFromMonth } from "./signal-start";

describe("레이더에서 넘어온 달 → 출발일 초기값 (FR-MO-061 · #764)", () => {
  it("🔴 다음 달 이후면 그 달 1일이다", () => {
    expect(startDateFromMonth("2026-11", "2026-09-22")).toBe("2026-11-01");
    expect(startDateFromMonth("2027-01", "2026-12-31")).toBe("2027-01-01");
  });

  it("🔴 이 달이면 오늘이다 — 1일은 이미 지났다", () => {
    expect(startDateFromMonth("2026-09", "2026-09-22")).toBe("2026-09-22");
    expect(startDateFromMonth("2026-09", "2026-09-01")).toBe("2026-09-01");
  });

  it("지난 달이나 꼴이 아닌 값은 채우지 않는다", () => {
    expect(startDateFromMonth("2026-08", "2026-09-22")).toBeNull();
    expect(startDateFromMonth("2026-13", "2026-09-22")).toBeNull();
    expect(startDateFromMonth("", "2026-09-22")).toBeNull();
  });
});
