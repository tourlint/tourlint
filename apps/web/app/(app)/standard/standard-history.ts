// 표준 변경 이력 (UI-S8-009). 표준 값(등급별 감점 · 종류 쏠림 기준 · R07 표준값 · 표 3종)을 바꾸면
// `@tourlint/shared` 의 STANDARD_VERSION 을 올리고 여기 한 줄을 더한다 — 마지막 줄이 지금 표준이다.

export interface StandardRevision {
  readonly version: string;
  /** 적용한 날 YYYY-MM-DD */
  readonly date: string;
  readonly summary: string;
}

export const STANDARD_HISTORY: readonly StandardRevision[] = [
  {
    version: "2026.09",
    date: "2026-09-15",
    summary:
      "표준을 처음 정했어요 — 등급별 감점 25 · 10 · 4 · 3, 같은 유형 3곳, 연속 일정 6시간 · 식사 60분, " +
      "타깃 · 콘셉트 기대 구성 63칸, 장소 종류별 기본 체류시간 47종 · 실내 · 야외 59종. 계정마다 따로 두던 값을 모든 계정에 같게 했어요.",
  },
];

/** 회사 기준 중 표준보다 엄격하게 정한 것의 수 (UI-S8-002). 표준과 같은 값은 표준을 쓰는 것이다 */
export function companyCriteriaInEffect(
  company: { r07SpanHours: number; r07MealMinutes: number },
  standard: { r07SpanHours: number; r07MealMinutes: number },
): number {
  return (company.r07SpanHours < standard.r07SpanHours ? 1 : 0) + (company.r07MealMinutes > standard.r07MealMinutes ? 1 : 0);
}
