import { describe, expect, it } from "vitest";
import { hhmm, savedLabel } from "./save-status";

describe("자동 저장 표시 (개편안 4-1 변경 지점 8)", () => {
  it("🔴 시:분을 두 자리로 채운다 (로컬 시각)", () => {
    // 로컬 구성요소로 만들고 로컬 구성요소로 읽으므로 시간대와 무관하게 결정적이다
    expect(hhmm(new Date(2026, 0, 1, 9, 41))).toBe("09:41");
    expect(hhmm(new Date(2026, 0, 1, 23, 5))).toBe("23:05");
    expect(hhmm(new Date(2026, 0, 1, 0, 0))).toBe("00:00");
  });

  it("저장 전에는 시각 없이, 저장 뒤에는 시각을 붙인다", () => {
    expect(savedLabel(null)).toBe("자동 저장됨");
    expect(savedLabel("09:41")).toBe("자동 저장됨 09:41");
  });
});
