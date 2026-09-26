import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Patch, ProductDetail, ProductItem } from "../../../lib/api";
import { describePatch, PatchDescription } from "./patch-description";

const a: ProductItem = { itemId: 1, seq: 1, start: "10:00", end: "11:30", place: "강릉 경포대", itemType: "SIGHT", ktoContentId: null, matchStatus: "CONFIRMED", mapx: null, mapy: null };
const b: ProductItem = { ...a, itemId: 2, seq: 2, start: "11:00", end: "12:30", place: "강릉 오죽헌·시립박물관" };
const product: Pick<ProductDetail, "days"> = { days: [{ day: 1, items: [a, b] }, { day: 2, items: [{ ...a, itemId: 3, end: null }] }] };
const patch = (type: Patch["type"], targetItemId: number, payload: Patch["payload"] = {}): Patch => ({ patchId: "p-1", type, targetItemId, payload });

describe("수정안의 실제 대상과 전후 표시 (#567)", () => {
  it("겹침의 뒤 장소를 미룰 때 오죽헌·시립박물관 전체 이름과 원래/새 시간을 보인다", () => {
    const result = describePatch(patch("TIME_SHIFT", 2, { newStartTime: "12:00", newEndTime: "13:30" }), product);
    expect(result.changes).toEqual([{ place: b.place, context: "1일차 · 2번째 일정", before: "1일차 · 11:00 – 12:30", after: "1일차 · 12:00 – 13:30" }]);
  });
  it("앞 장소의 종료만 줄이는 수정안은 경포대 시작 시간을 명시적으로 유지한다", () => {
    const result = describePatch(patch("TIME_SHIFT", 1, { newEndTime: "10:54" }), product);
    expect(result.changes[0]).toMatchObject({ place: a.place, before: "1일차 · 10:00 – 11:30", after: "1일차 · 10:00 – 10:54" });
    expect(JSON.stringify(result)).not.toContain("그대로");
  });
  it("일차 이동과 시작만 변경은 변경하지 않는 종료 시간을 유지한다", () => {
    expect(describePatch(patch("TIME_SHIFT", 2, { newDayNo: 2, newStartTime: "12:00" }), product).changes[0]?.after).toBe("2일차 · 12:00 – 12:30");
  });
  it("같은 이름 재방문은 id로 구분하고 종료 미입력을 임의로 채우지 않는다", () => {
    const result = describePatch(patch("TIME_SHIFT", 3, { newStartTime: "11:00" }), product);
    expect(result.changes[0]).toMatchObject({ context: "2일차 · 1번째 일정", before: "2일차 · 10:00 – 종료 미입력", after: "2일차 · 11:00 – 종료 미입력" });
  });
  it("순서 교환은 양쪽 장소의 바뀌는 시간을 모두 보인다", () => {
    const result = describePatch(patch("REORDER", 1, { swapWithItemId: 2 }), product);
    expect(result.changes.map(c => [c.place, c.before, c.after])).toEqual([
      [a.place, "1일차 · 10:00 – 11:30", "1일차 · 11:00 – 12:30"],
      [b.place, "1일차 · 11:00 – 12:30", "1일차 · 10:00 – 11:30"],
    ]);
  });
  it("장소 교체는 기존과 새 장소·거리를 명시한다", () => {
    const result = describePatch({ ...patch("REPLACE_CONTENT", 2, { distanceMeters: 1250 }), placeName: "선교장" }, product);
    expect(result.changes[0]).toMatchObject({ before: b.place, after: "선교장" });
    expect(result.note).toContain("1.3km");
    expect(describePatch(patch("REPLACE_CONTENT", 2), product).changes[0]?.after).toBe("대체 장소 이름 확인 불가");
  });
  it("🔴 거리가 어디서부터인지 적는다 — 앞 일정에서 찾았으면 그 이름, 아니면 지금 장소 (#728)", () => {
    const fromPrev = describePatch(patch("REPLACE_CONTENT", 2, { distanceMeters: 400, fromItemId: 1 }), product);
    expect(fromPrev.note).toBe("앞 일정 강릉 경포대에서 약 400m · 방문 일차·시간은 유지됩니다.");
    const fromSelf = describePatch(patch("REPLACE_CONTENT", 2, { distanceMeters: 1250 }), product);
    expect(fromSelf.note).toBe("지금 장소에서 약 1.3km · 방문 일차·시간은 유지됩니다.");
    // 기준 일정을 못 찾아도 「앞 일정에서」 라고는 말한다 — 지금 장소 기준이라고 잘못 적지 않는다
    expect(describePatch(patch("REPLACE_CONTENT", 2, { distanceMeters: 400, fromItemId: 99 }), product).note).toContain("앞 일정에서 약 400m");
    expect(JSON.stringify(fromPrev)).not.toContain("대체 장소까지");
  });
  it("새 식사와 장소 추가는 일차·시간·종류를 명시한다", () => {
    const result = describePatch(patch("INSERT_ITEM", 1, { dayNo: 2, startTime: "12:00", endTime: "13:00", itemType: "MEAL" }), product);
    expect(result.action).toBe("식사 추가");
    expect(result.changes[0]).toMatchObject({ place: "식사 시간", after: "2일차 · 12:00 – 13:00" });
  });
  it("삭제하는 장소를 다른 장소와 혼동하지 않는다", () => {
    expect(describePatch(patch("REMOVE_ITEM", 2), product).changes[0]).toMatchObject({ place: b.place, context: "1일차 · 2번째 일정", after: "이 장소를 일정에서 삭제" });
  });
  it("없는 대상을 finding의 다른 장소로 대체하거나 시간을 추정하지 않는다", () => {
    const result = describePatch(patch("TIME_SHIFT", 99, { newEndTime: "10:54" }), product);
    expect(result.changes[0]).toMatchObject({ place: "일정 #99", context: "현재 항목 확인 불가", before: "현재 일정 확인 불가", after: "일차 확인 불가 · 시작 확인 불가 – 10:54" });
    expect(describePatch(patch("REMOVE_ITEM", 2), null).changes[0]?.place).toBe("일정 #2");
  });
  it("화면에도 장소·순번·현재/변경 후가 생략 없이 렌더링된다", () => {
    const html = renderToStaticMarkup(<PatchDescription patch={patch("TIME_SHIFT", 2, { newStartTime: "12:00", newEndTime: "13:30" })} product={product} />);
    for (const text of [b.place, "1일차 · 2번째 일정", "현재", "변경 후", "11:00 – 12:30", "12:00 – 13:30"]) expect(html).toContain(text);
    expect(html).not.toContain("truncate");
  });
});

describe("다른 날과 맞바꾸기 · 이동시간 모름 (#877)", () => {
  const lunch: ProductItem = { ...a, itemId: 11, seq: 1, start: "13:00", end: "14:00", place: "가람집옹심이", itemType: "MEAL" };
  const other: ProductItem = { ...a, itemId: 12, seq: 1, start: "12:30", end: "13:30", place: "초당할머니순두부", itemType: "MEAL" };
  const twoDays: Pick<ProductDetail, "days"> = { days: [{ day: 1, items: [lunch] }, { day: 3, items: [other] }] };

  it("🔴 다른 날 일정과 맞바꾸면 일차까지 바뀐다고 적는다", () => {
    const result = describePatch(patch("REORDER", 11, { swapWithItemId: 12 }), twoDays);
    expect(result.action).toBe("두 장소의 방문 일차·시간 교환");
    expect(result.changes.map(c => [c.place, c.before, c.after])).toEqual([
      ["가람집옹심이", "1일차 · 13:00 – 14:00", "3일차 · 12:30 – 13:30"],
      ["초당할머니순두부", "3일차 · 12:30 – 13:30", "1일차 · 13:00 – 14:00"],
    ]);
  });

  it("같은 날 맞바꾸기는 이름이 그대로다 — 가이드 11-1 의 「두 장소의 방문 순서·시간 교환」", () => {
    expect(describePatch(patch("REORDER", 1, { swapWithItemId: 2 }), product).action).toBe("두 장소의 방문 순서·시간 교환");
  });

  it("🔴 이동시간을 몰라 겹침만 푼 안은 그 사실을 적는다 (FR-RU-033)", () => {
    const result = describePatch(patch("TIME_SHIFT", 2, { newStartTime: "12:00", newEndTime: "13:30", travelUnchecked: true }), product);
    expect(result.note).toBe("이동시간을 확인하지 못해 겹침만 풀었어요. 반영 후 다시 검수해 확인해요.");
    expect(describePatch(patch("TIME_SHIFT", 2, { newStartTime: "12:00" }), product).note).toBeUndefined();
  });
});
