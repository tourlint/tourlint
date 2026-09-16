import { COMPANY_SETTING_LIMITS } from "@tourlint/shared";

// 회사 기준 입력을 화면에서 먼저 검증한다 (서버 규칙과 같다 · FR-OP-022). 회사 기준은
// 표준보다 엄격하게만 — 연속 일정은 표준 이하, 식사는 표준 이상. 서버도 400
// SETTING_NOT_STRICTER 로 막지만, 저장을 누르기 전에 같은 말을 보여 주는 게 친절하다.

export interface CompanyDraft {
  r07SpanHours: number;
  r07MealMinutes: number;
}

export interface CompanyFieldErrors {
  r07SpanHours?: string;
  r07MealMinutes?: string;
}

const { r07SpanHoursMax, r07MealMinutesMin } = COMPANY_SETTING_LIMITS;

export function validateCompanyDraft(d: CompanyDraft): CompanyFieldErrors {
  const errors: CompanyFieldErrors = {};

  if (!Number.isInteger(d.r07SpanHours) || d.r07SpanHours < 1) {
    errors.r07SpanHours = "1 이상 정수로 입력하세요.";
  } else if (d.r07SpanHours > r07SpanHoursMax) {
    errors.r07SpanHours = `표준 ${r07SpanHoursMax}시간보다 길게는 정할 수 없어요. 회사 기준은 표준보다 엄격하게만 정합니다.`;
  }

  if (!Number.isInteger(d.r07MealMinutes) || d.r07MealMinutes > 240) {
    errors.r07MealMinutes = "240 이하 정수로 입력하세요.";
  } else if (d.r07MealMinutes < r07MealMinutesMin) {
    errors.r07MealMinutes = `표준 ${r07MealMinutesMin}분보다 짧게는 정할 수 없어요. 회사 기준은 표준보다 엄격하게만 정합니다.`;
  }

  return errors;
}

export function hasCompanyErrors(e: CompanyFieldErrors): boolean {
  return e.r07SpanHours !== undefined || e.r07MealMinutes !== undefined;
}
