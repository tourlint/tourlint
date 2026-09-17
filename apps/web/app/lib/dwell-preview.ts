import { DWELL_MINUTES_SEED, SETTING_DEFAULTS } from "@tourlint/shared";

// 끝 시간을 비운 항목에 검수가 채울 '보통 머무는 시간' 미리보기 (FR-IN-011). 엔진의
// engine/itinerary/dwell.ts 와 같은 표를 본다 — 화면이 다른 값을 지어내면 실제 검수와 어긋난다.
//   · 숙박(AC*)은 끝 시간이 없어 null
//   · 중분류 표에 있으면 그 값, 없으면(미매핑) 90분 기본

export function dwellPreview(lcls2: string | null): number | null {
  if (lcls2 !== null && lcls2.startsWith("AC")) return null;
  if (lcls2 === null) return SETTING_DEFAULTS.dwellFallbackMinutes;
  return DWELL_MINUTES_SEED[lcls2] ?? SETTING_DEFAULTS.dwellFallbackMinutes;
}
