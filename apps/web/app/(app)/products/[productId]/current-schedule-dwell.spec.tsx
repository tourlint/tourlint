import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProductItem } from "../../../lib/api";
import { CurrentSchedule } from "./current-schedule";

const item = (over: Partial<ProductItem>): ProductItem => ({
  itemId: 1, seq: 1, start: "10:00", end: "11:30", place: "경포대", itemType: "SIGHT", ktoContentId: "1",
  matchStatus: "CONFIRMED", mapx: null, mapy: null, lcls2: "HS01", endTimeSource: "INPUT", ...over,
});
const render = (items: ProductItem[]) => renderToStaticMarkup(
  <CurrentSchedule product={{ days: [{ day: 1, items }] }} finding={null} expanded onToggle={() => {}} />,
);

describe("현재 일정표 — 끝 시간을 비운 줄 (FR-IN-011 · EX-IN-009)", () => {
  it("🔴 「종료 미입력」 대신 검수가 채운 시각과 「기본값 적용 · N분」 을 보인다", () => {
    const html = render([item({ itemId: 3, place: "주문진 등대", start: "14:30", end: null, lcls2: null, matchStatus: "EXCLUDED", endTimeSource: "DWELL_DEFAULT" })]);
    expect(html).toContain("16:00");
    expect(html).toContain("기본값 적용 · 90분");
    expect(html).not.toContain("종료 미입력");
  });

  it("🔴 장소 담기가 채운 끝 시각에도 붙인다", () => {
    expect(render([item({ start: "13:32", end: "14:32", lcls2: "FD01", itemType: "MEAL", endTimeSource: "DWELL_DEFAULT" })]))
      .toContain("기본값 적용 · 60분");
  });

  it("숙박 · 직접 적은 끝 · 분류를 모르는 줄은 그대로다", () => {
    const html = render([
      item({ itemId: 1 }),
      item({ itemId: 2, seq: 2, itemType: "LODGING", start: "18:00", end: null, lcls2: "AC01", endTimeSource: "DWELL_DEFAULT" }),
      item({ itemId: 3, seq: 3, end: null, lcls2: undefined, endTimeSource: undefined }),
    ]);
    expect(html).not.toContain("기본값 적용");
    expect(html.match(/종료 미입력/g)).toHaveLength(2);
  });
});
