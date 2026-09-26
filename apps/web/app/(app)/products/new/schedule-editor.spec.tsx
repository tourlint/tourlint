import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScheduleEditor, dwellOfRow } from "./schedule-editor";
import type { ScheduleItem } from "./types";

const picked: ScheduleItem = {
  id: "pk-1", start: "14:30", end: "", place: "주문진 등대", itemType: "SIGHT", origin: "PICKER",
  content: { contentId: "126175", contentTypeId: 12, mapx: 128.8, mapy: 37.9, lcls1: "VE", lcls2: "VE01", lcls3: null },
};

describe("일정 입력 — 끝 시간을 비운 줄 (UI-S2-009)", () => {
  it("🔴 고른 곳의 분류로 채워질 시각과 「기본값 적용 · N분」 을 미리 보인다", () => {
    const html = renderToStaticMarkup(<ScheduleEditor nights={0} schedule={[[picked]]} onChange={() => {}} />);
    expect(html).toContain("끝 시간을 비우면 15:30까지로 채워요");
    expect(html).toContain("기본값 적용 · 60분");
  });

  it("아직 고르지 않은 줄은 분류를 몰라 짓지 않는다 · 숙박은 채우지 않는다", () => {
    expect(dwellOfRow({ ...picked, content: null })).toBeNull();
    expect(dwellOfRow({ ...picked, itemType: "LODGING" })).toBeNull();
  });

  it("🔴 편집 화면 — 체류시간으로 채운 끝 시각은 손대기 전까지 「기본값 적용」, 고치면 뗀다", () => {
    const saved: ScheduleItem = {
      id: "srv-9", itemId: 9, start: "12:05", end: "13:35", place: "하슬라아트월드", itemType: "SIGHT",
      saved: { end: "13:35", endTimeSource: "DWELL_DEFAULT", lcls2: "VE07", matchStatus: "CONFIRMED" },
    };
    expect(dwellOfRow(saved)).toEqual({ minutes: 90, end: "13:35", preview: false });
    expect(dwellOfRow({ ...saved, end: "13:45" })).toBeNull();
    // 고르는 중인 줄은 저장된 분류가 없다
    expect(dwellOfRow({ ...saved, end: "", saved: { ...saved.saved!, matchStatus: "PENDING", lcls2: null } })).toBeNull();
  });
});
