import { describe, expect, it } from "vitest";
import { isEmptyPlan, planSchedule, type EditedItem } from "./schedule-diff";

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
