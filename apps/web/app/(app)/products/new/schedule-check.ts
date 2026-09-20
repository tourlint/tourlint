// 저장 전에 일정 줄을 훑는다 (#673).
//
// 서버는 줄마다 장소명 · 시작 시각 · 유형 셋을 요구하는데(validateDays) 화면의 저장 전
// 검사는 상품명 · 여행 지역 · 출발일만 봤다. 그래서 「+ 항목 추가」로 만들어 두고 채우지
// 않은 줄이 있으면 저장이 400 으로 막히는데 화면은 「잠시 후 다시 시도해 주세요」만 띄웠다.
//
// 아무것도 안 채운 줄은 버린다 — 추가만 하고 만 줄이다. 일부만 채운 줄은 일차 · 줄 번호와
// 함께 무엇이 비었는지 말한다. 말은 서버와 같게 맞춘다.

import type { Schedule, ScheduleItem } from "./types";

/** 손대지 않은 빈 줄인가 */
function untouched(it: ScheduleItem): boolean {
  return (
    it.place.trim() === "" &&
    it.start === "" &&
    it.end === "" &&
    it.itemType === "" &&
    !it.content
  );
}

/** 추가만 하고 만 줄을 버린 일정 */
export function pruneEmptyItems(schedule: Schedule): Schedule {
  return schedule.map((items) => items.filter((it) => !untouched(it)));
}

/** 채우다 만 줄을 일차 · 줄 번호로 짚는다. 빈 줄은 이미 버려진 뒤다 */
export function scheduleErrors(schedule: Schedule): string[] {
  const errors: string[] = [];
  schedule.forEach((items, dayIdx) => {
    items.forEach((it, i) => {
      const at = `${dayIdx + 1}일차 ${i + 1}번`;
      if (it.place.trim() === "") errors.push(`${at} 장소명을 입력하세요.`);
      if (it.start === "") errors.push(`${at} 시작 시각을 입력하세요.`);
      if (it.itemType === "") errors.push(`${at} 유형을 고르세요.`);
    });
  });
  return errors;
}
