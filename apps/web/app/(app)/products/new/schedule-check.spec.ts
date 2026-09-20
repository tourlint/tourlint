import { describe, expect, it } from "vitest";
import { pruneEmptyItems, scheduleErrors } from "./schedule-check";
import type { Schedule, ScheduleItem } from "./types";

const row = (over: Partial<ScheduleItem> = {}): ScheduleItem => ({
  id: "a", start: "09:00", end: "10:00", place: "경포대", itemType: "SIGHT", ...over,
});
const empty = (): ScheduleItem => ({ id: "e", start: "", end: "", place: "", itemType: "" });

describe("저장 전 일정 훑기 (#673)", () => {
  it("🔴 추가만 하고 만 줄은 버린다 — 이것 때문에 저장이 막혔다", () => {
    const schedule: Schedule = [[row(), empty()], [empty()]];
    const pruned = pruneEmptyItems(schedule);
    expect(pruned[0]).toHaveLength(1);
    expect(pruned[1]).toHaveLength(0);
    expect(scheduleErrors(pruned)).toEqual([]);
  });

  it("🔴 채우다 만 줄은 일차와 줄 번호로 짚는다", () => {
    const schedule: Schedule = [[row(), row({ place: "  ", itemType: "" })]];
    expect(scheduleErrors(schedule)).toEqual([
      "1일차 2번 장소명을 입력하세요.",
      "1일차 2번 유형을 고르세요.",
    ]);
  });

  it("고른 장소가 달린 줄은 비어 있어도 버리지 않는다", () => {
    const picked = row({ place: "", start: "", end: "", itemType: "", content: { contentId: "1", contentTypeId: 12, mapx: null, mapy: null, lcls1: null, lcls2: null, lcls3: null } });
    expect(pruneEmptyItems([[picked]])[0]).toHaveLength(1);
  });

  it("다 채운 일정은 아무 말도 하지 않는다", () => {
    expect(scheduleErrors([[row(), row({ id: "b" })]])).toEqual([]);
  });
});
