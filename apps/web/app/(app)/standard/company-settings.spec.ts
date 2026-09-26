import { describe, expect, it } from "vitest";
import { hasCompanyErrors, strictnessLabel, validateCompanyDraft } from "./company-settings";

describe("validateCompanyDraft — 회사 기준은 표준보다 엄격하게만", () => {
  it("연속 일정 7시간은 표준(6)보다 느슨해 막는다", () => {
    const e = validateCompanyDraft({ r07SpanHours: 7, r07MealMinutes: 60 });
    expect(e.r07SpanHours).toBeDefined();
    expect(hasCompanyErrors(e)).toBe(true);
  });

  it("연속 일정 5시간은 허용한다", () => {
    const e = validateCompanyDraft({ r07SpanHours: 5, r07MealMinutes: 60 });
    expect(e.r07SpanHours).toBeUndefined();
  });

  it("식사 30분은 표준(60)보다 느슨해 막는다", () => {
    const e = validateCompanyDraft({ r07SpanHours: 6, r07MealMinutes: 30 });
    expect(e.r07MealMinutes).toBeDefined();
  });

  it("식사 90분은 허용한다", () => {
    const e = validateCompanyDraft({ r07SpanHours: 6, r07MealMinutes: 90 });
    expect(hasCompanyErrors(e)).toBe(false);
  });

  it("표준과 같은 6시간 · 60분은 허용한다", () => {
    expect(hasCompanyErrors(validateCompanyDraft({ r07SpanHours: 6, r07MealMinutes: 60 }))).toBe(false);
  });
});

describe("칸 아래 표시 (UI-S8-006)", () => {
  it("🔴 표준과 같으면 「표준과 같음」, 엄격하면 「표준보다 엄격」, 막힌 값은 표시하지 않는다", () => {
    expect(strictnessLabel(60, 60, undefined)).toBe("표준과 같음");
    expect(strictnessLabel(90, 60, undefined)).toBe("표준보다 엄격");
    expect(strictnessLabel(5, 6, undefined)).toBe("표준보다 엄격");
    expect(strictnessLabel(45, 60, "표준 60분보다 짧게는 정할 수 없어요.")).toBeNull();
  });
});
