import { describe, expect, it } from "vitest";
import { importedSchedule, type ParsedItem } from "./imported-schedule";

const row = (day: number, place: string): ParsedItem => ({
  day, start: "09:00", end: null, place, itemType: "SIGHT",
});

describe("읽어 온 일정을 폼에 넣기 (#670)", () => {
  it("일차대로 나눠 담는다", () => {
    const r = importedSchedule([row(1, "경포대"), row(2, "오죽헌")], 2, 1);
    expect(r.schedule[0].map((i) => i.place)).toEqual(["경포대"]);
    expect(r.schedule[1].map((i) => i.place)).toEqual(["오죽헌"]);
    expect(r.put).toBe(2);
    expect(r.dropped).toBe(0);
  });

  /**
   * 편집 화면은 박수를 바꿀 수 없다. 2박 3일 파일을 당일 상품에 올리면 2·3일차는 갈 곳이
   * 없는데, 조용히 흘리면 저장한 뒤에야 없어진 것을 안다.
   */
  it("🔴 일수를 넘는 항목은 버리고 몇 개를 버렸는지 알려 준다", () => {
    const r = importedSchedule([row(1, "경포대"), row(2, "오죽헌"), row(3, "정동진")], 1, 1);
    expect(r.schedule).toHaveLength(1);
    expect(r.put).toBe(1);
    expect(r.dropped).toBe(2);
  });

  it("끝 시간이 없으면 빈 칸으로 둔다 — 검수가 보통 머무는 시간으로 채운다", () => {
    const r = importedSchedule([row(1, "경포대")], 1, 1);
    expect(r.schedule[0][0].end).toBe("");
  });

  it("빈 파일이면 일정이 비워진다", () => {
    const r = importedSchedule([], 3, 1);
    expect(r.schedule).toEqual([[], [], []]);
    expect(r.put).toBe(0);
  });
});
