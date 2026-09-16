import { describe, expect, it } from "vitest";
import { hasCompanyErrors, validateCompanyDraft } from "./company-settings";

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
