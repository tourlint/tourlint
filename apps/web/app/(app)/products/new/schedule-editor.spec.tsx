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

  it("🔴 편집 화면 — 직접 정한 곳은 끝을 비워도 · 체류시간으로 채웠어도 짓지 않는다", () => {
    const walk: ScheduleItem = {
      id: "srv-12", itemId: 12, start: "14:00", end: "15:30", place: "해파랑길 35코스", itemType: "SIGHT",
      saved: { end: "15:30", endTimeSource: "DWELL_DEFAULT", lcls2: null, matchStatus: "EXCLUDED" },
    };
    expect(dwellOfRow(walk)).toBeNull();
    expect(dwellOfRow({ ...walk, end: "" })).toBeNull();
    const html = renderToStaticMarkup(<ScheduleEditor nights={0} schedule={[[{ ...walk, end: "" }]]} onChange={() => {}} />);
    expect(html).not.toContain("기본값 적용");
    expect(html).not.toContain("까지로 채워요");
  });

  it("🔴 직접 정한 곳으로 둔 줄은 그 표시가 붙고 근처 3km 기준으로 쓸 수 없다 (UI-S2-021)", () => {
    const html = renderToStaticMarkup(<ScheduleEditor nights={0} regnCd="51" signguCd="150" regionLabel="강릉시" onAnchorChange={() => {}}
      schedule={[[{ id: "it-1", start: "09:00", end: "09:30", place: "강릉역", itemType: "MOVE", excluded: true }]]} onChange={() => {}} />);
    expect(html).toContain("직접 정한 곳");
    const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];
    expect(checkbox).toMatch(/\sdisabled(?:=|\s|>)/);
  });
});
