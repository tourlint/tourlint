import { describe, expect, it } from "vitest";
import { isEmptyPlan, placeCalls, planSchedule, type EditedItem } from "./schedule-diff";
import type { ScheduleItem } from "../(app)/products/new/types";

const item = (over: Partial<EditedItem> = {}): EditedItem => ({
  itemId: 1, dayNo: 1, seq: 1, startTime: "10:00", endTime: "11:30",
  placeLabel: "경포대", itemType: "SIGHT", ...over,
});

describe("일정 편집 비교 (FR-IN-014)", () => {
  it("바뀐 게 없으면 아무 호출도 내지 않는다", () => {
    const before = [item()];
    const plan = planSchedule(before, [item()]);
    expect(isEmptyPlan(plan)).toBe(true);
  });

  it("값이 바뀐 필드만 담는다", () => {
    const plan = planSchedule([item()], [item({ startTime: "11:00" })]);
    expect(plan.patched).toEqual([{ itemId: 1, patch: { startTime: "11:00" } }]);
  });

  it("사라진 항목은 삭제, 새 항목은 추가로 간다", () => {
    const before = [item({ itemId: 1 }), item({ itemId: 2, seq: 2, placeLabel: "오죽헌" })];
    const after = [item({ itemId: 1 }), item({ itemId: undefined, seq: 2, placeLabel: "감천골" })];
    const plan = planSchedule(before, after);
    expect(plan.removed).toEqual([2]);
    expect(plan.added.map((i) => i.placeLabel)).toEqual(["감천골"]);
  });

  it("🔴 자리를 안 옮겼으면 순서 변경을 보내지 않는다", () => {
    const before = [item({ itemId: 1 }), item({ itemId: 2, seq: 2 })];
    const plan = planSchedule(before, [item({ itemId: 1, placeLabel: "다른 이름" }), item({ itemId: 2, seq: 2 })]);
    expect(plan.patched).toHaveLength(1);
    expect(plan.needsOrder).toBe(false);
    expect(plan.order).toEqual([]);
  });

  it("자리가 바뀌면 전체 자리를 다시 보낸다", () => {
    const before = [item({ itemId: 1, seq: 1 }), item({ itemId: 2, seq: 2 })];
    const after = [item({ itemId: 2, seq: 1 }), item({ itemId: 1, seq: 2 })];
    const plan = planSchedule(before, after);
    expect(plan.needsOrder).toBe(true);
    expect(plan.order.map((i) => i.itemId)).toEqual([2, 1]);
  });

  it("일차를 옮긴 것도 자리 변경이다", () => {
    const plan = planSchedule([item()], [item({ dayNo: 2 })]);
    expect(plan.needsOrder).toBe(true);
    expect(plan.order).toEqual([item({ dayNo: 2 })]);
  });

  it("🔴 새로 추가한 항목도 순서에 들어간다 — 하나라도 빠지면 서버가 400 이다", () => {
    const before = [item({ itemId: 1 })];
    const after = [item({ itemId: 1 }), item({ itemId: undefined, seq: 2, placeLabel: "추가한 곳" })];
    const plan = planSchedule(before, after);
    expect(plan.order).toHaveLength(2);
    expect(plan.order[1]?.itemId).toBeUndefined();
    expect(plan.order[1]?.placeLabel).toBe("추가한 곳");
  });

  it("추가·삭제가 있으면 남은 항목의 자리를 다시 매긴다", () => {
    const before = [item({ itemId: 1 }), item({ itemId: 2, seq: 2 })];
    const after = [item({ itemId: 2, seq: 1 })];
    const plan = planSchedule(before, after);
    expect(plan.removed).toEqual([1]);
    expect(plan.order.map((i) => i.itemId)).toEqual([2]);
  });
});

describe("장소 담기로 고른 줄 (#665)", () => {
  const picked = {
    contentId: "126508", contentTypeId: 12, mapx: 128.8, mapy: 37.8,
    lcls1: "NA", lcls2: "NA01", lcls3: null,
  };

  it("🔴 고른 관광지를 새 항목에 달아 둔다 — 저장할 때 확정으로 넣어야 한다", () => {
    const plan = planSchedule([], [item({ itemId: undefined, content: picked })]);
    expect(plan.added).toHaveLength(1);
    expect(plan.added[0].content).toEqual(picked);
  });

  it("고른 곳이 아니면 달려 있지 않다 — 손으로 친 줄은 미확정으로 들어간다", () => {
    const plan = planSchedule([], [item({ itemId: undefined })]);
    expect(plan.added[0].content).toBeUndefined();
  });

  it("이미 저장된 줄은 고른 관광지를 견주지 않는다 — 바뀐 값만 보낸다", () => {
    const plan = planSchedule([item()], [item({ content: picked })]);
    expect(isEmptyPlan(plan)).toBe(true);
  });
});

describe("불러온 줄의 장소 상태 바꾸기 (UI-S2-021 · FR-IN-029)", () => {
  const picked = {
    contentId: "2733968", contentTypeId: 12, mapx: 128.9, mapy: 37.8, lcls1: "NA", lcls2: "NA04", lcls3: null,
  };
  const loaded = (over: Partial<ScheduleItem> = {}, saved: Partial<NonNullable<ScheduleItem["saved"]>> = {}): ScheduleItem => ({
    id: "srv-11", itemId: 11, start: "09:00", end: "10:00", place: "경포해변", itemType: "SIGHT",
    saved: { end: "10:00", matchStatus: "PENDING", contentId: null, ...saved }, ...over,
  });

  it("🔴 고르는 중이던 줄에 새로 고른 곳은 확정한다", () => {
    expect(placeCalls([loaded({ content: picked })])).toEqual({ exclude: [], match: [{ itemId: 11, contentId: "2733968" }] });
  });

  it("🔴 고른 곳이 함께 걸린 줄은 직접 정한 곳으로 보내지 않는다 — 후보를 확인하는 사이 둘 다 걸릴 수 있다", () => {
    expect(placeCalls([loaded({ content: picked, excluded: true })]).exclude).toEqual([]);
    expect(placeCalls([loaded({ excluded: true })]).exclude).toEqual([11]);
  });

  it("🔴 저장된 곳을 그대로 다시 고른 줄은 부르지 않는다 — 기준으로 쓰려고 확인한 줄이다", () => {
    const confirmed = { matchStatus: "CONFIRMED", contentId: "2733968" };
    expect(placeCalls([loaded({ content: picked }, confirmed)]).match).toEqual([]);
    expect(placeCalls([loaded({ content: { ...picked, contentId: "126508" } }, confirmed)]).match)
      .toEqual([{ itemId: 11, contentId: "126508" }]);
  });

  it("🔴 새 줄 · 걷기 길은 확정하지 않는다 — 새 줄은 추가가 넣고, 걷기 길은 확정할 수 없는 줄이다", () => {
    expect(placeCalls([
      loaded({ itemId: undefined, content: picked }),
      loaded({ walk: { walkId: "T_CRS_MNG0000000402" }, content: picked }, { matchStatus: "EXCLUDED" }),
    ])).toEqual({ exclude: [], match: [] });
  });
});
