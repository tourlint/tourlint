// 엑셀 · 자연어로 읽은 일정을 폼 모델로 옮긴다 (UI-S2-010 · #670).
//
// 편집 화면은 **박수를 바꿀 수 없다.** 읽은 파일이 2박 3일이어도 당일 상품에 넣으면 2·3일차
// 항목은 갈 곳이 없다. 조용히 흘리면 저장한 뒤에야 없어진 걸 알게 되므로 버린 수를 함께
// 돌려주고 화면이 말하게 한다.

import type { ItemType, Schedule } from "./types";

export interface ParsedItem {
  day: number;
  start: string;
  end: string | null;
  place: string;
  itemType: ItemType;
}

export interface ImportedSchedule {
  schedule: Schedule;
  /** 넣은 항목 수 */
  put: number;
  /** 일수를 넘어 버린 항목 수 */
  dropped: number;
}

export function importedSchedule(items: readonly ParsedItem[], dayCount: number, seq: number): ImportedSchedule {
  const days = Math.max(1, dayCount);
  const schedule: Schedule = Array.from({ length: days }, () => []);
  let put = 0;
  let dropped = 0;
  for (const it of items) {
    const day = it.day - 1;
    if (day < 0 || day >= days) {
      dropped += 1;
      continue;
    }
    put += 1;
    schedule[day].push({
      id: `up-${seq}-${put}`,
      start: it.start,
      end: it.end ?? "",
      place: it.place,
      itemType: it.itemType,
    });
  }
  return { schedule, put, dropped };
}
