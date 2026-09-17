import { describe, expect, it } from "vitest";
import { DWELL_MINUTES_SEED } from "@tourlint/shared";
import { dwellPreview } from "./dwell-preview";

describe("dwellPreview — 끝 시간 미리보기 (FR-IN-011)", () => {
  it("숙박(AC*)은 끝 시간이 없어 null 이다", () => {
    expect(dwellPreview("AC01")).toBeNull();
    expect(dwellPreview("AC05")).toBeNull();
  });

  it("표에 없는 중분류는 90분 기본이다", () => {
    // 표에 없는 코드
    expect(dwellPreview("ZZ99")).toBe(90);
  });

  it("표에 있는 중분류는 그 값이다 (엔진 표와 같아야 한다)", () => {
    const anyKey = Object.keys(DWELL_MINUTES_SEED).find((k) => !k.startsWith("AC"));
    expect(anyKey).toBeDefined();
    expect(dwellPreview(anyKey as string)).toBe(DWELL_MINUTES_SEED[anyKey as string]);
  });
});
