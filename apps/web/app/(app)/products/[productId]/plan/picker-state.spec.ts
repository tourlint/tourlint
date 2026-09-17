import { describe, expect, it } from "vitest";
import { initialPickerState, isInserted, pickerReducer, pickerStateWith } from "./picker-state";

describe("pickerReducer — 장소 담기 상태 (UI-S2-036~043)", () => {
  it("종류를 고르면 lcls2 가 바뀌고, 넣은 목록은 그대로다 (칩은 일정을 안 바꾼다)", () => {
    const withInserted = { ...initialPickerState, inserted: ["100"] };
    const s = pickerReducer(withInserted, { type: "SELECT_TYPE", lcls2: "VE01" });
    expect(s.lcls2).toBe("VE01");
    expect(s.inserted).toEqual(["100"]);
    expect(s.expandedId).toBeNull();
  });

  it("정렬을 바꿔도 넣은 목록 · 종류는 그대로다", () => {
    const base = { ...initialPickerState, lcls2: "VE01", inserted: ["100"] };
    const s = pickerReducer(base, { type: "SET_SORT", sort: "together" });
    expect(s.sort).toBe("together");
    expect(s.lcls2).toBe("VE01");
    expect(s.inserted).toEqual(["100"]);
  });

  it("자세히는 같은 카드를 다시 누르면 접힌다", () => {
    const open = pickerReducer(initialPickerState, { type: "TOGGLE_EXPAND", contentId: "1" });
    expect(open.expandedId).toBe("1");
    const closed = pickerReducer(open, { type: "TOGGLE_EXPAND", contentId: "1" });
    expect(closed.expandedId).toBeNull();
  });

  it("넣으면 그 곳이 '일정에 있음'이 되고 중복으로 쌓이지 않는다", () => {
    let s = pickerReducer(initialPickerState, { type: "MARK_INSERTED", contentId: "125769" });
    expect(isInserted(s, "125769")).toBe(true);
    s = pickerReducer(s, { type: "MARK_INSERTED", contentId: "125769" });
    expect(s.inserted).toEqual(["125769"]);
  });

  it("근처 3km 종류와 시군구 종류는 배타적이다", () => {
    let s = pickerReducer(initialPickerState, { type: "SELECT_TYPE", lcls2: "VE01" });
    s = pickerReducer(s, { type: "SELECT_NEAR", nearKind: "MEAL" });
    expect(s.nearKind).toBe("MEAL");
    expect(s.lcls2).toBeNull();
    s = pickerReducer(s, { type: "SELECT_TYPE", lcls2: "NA02" });
    expect(s.lcls2).toBe("NA02");
    expect(s.nearKind).toBeNull();
  });

  it("넣을 위치를 옮기면 열린 근처 3km 칩이 닫힌다 (다시 세야 하므로)", () => {
    let s = pickerReducer({ ...initialPickerState, anchorItemId: 1 }, { type: "SELECT_NEAR", nearKind: "CAFE" });
    expect(s.nearKind).toBe("CAFE");
    s = pickerReducer(s, { type: "SET_ANCHOR", anchorItemId: 2 });
    expect(s.anchorItemId).toBe(2);
    expect(s.nearKind).toBeNull();
  });

  it("필터를 켜고 끈다", () => {
    let s = pickerReducer(initialPickerState, { type: "TOGGLE_FILTER", key: "indoor" });
    expect(s.filters.indoor).toBe(true);
    s = pickerReducer(s, { type: "TOGGLE_FILTER", key: "indoor" });
    expect(s.filters.indoor).toBe(false);
  });
});

describe("pickerStateWith — 자주 넣는 곳 칩에서 연다 (UI-S2-030)", () => {
  it("🔴 openType 이 있으면 그 종류를 골라 둔 채로 시작한다", () => {
    expect(pickerStateWith("NA01").lcls2).toBe("NA01");
  });

  it("openType 이 없으면(null · 빈 문자열) 기본 상태다 — 아무 종류도 안 고름", () => {
    expect(pickerStateWith(null)).toEqual(initialPickerState);
    expect(pickerStateWith("").lcls2).toBeNull();
  });
});
