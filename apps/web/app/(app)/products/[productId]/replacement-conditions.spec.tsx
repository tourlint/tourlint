// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { planApi, type Patch, type ProductDetail, type ProductItem } from "../../../lib/api";
import { PatchDescription } from "./patch-description";

// 고른 대체 장소의 운영 조건 (UI-S3-016 · #880). 명세 예시 「인근 동일 유형 관광지로 대체 (B고택 · 4.2km · 연중무휴)」
const lunch: ProductItem = { itemId: 1, seq: 1, start: "13:00", end: "14:00", place: "가람집옹심이", itemType: "MEAL", ktoContentId: "2868839", matchStatus: "CONFIRMED", mapx: null, mapy: null };
const product: Pick<ProductDetail, "days"> = { days: [{ day: 1, items: [lunch] }] };
const replace: Patch = {
  patchId: "p-2", type: "REPLACE_CONTENT", targetItemId: 1, placeName: "맛드린",
  payload: { ktoContentId: "2868676", contentTypeId: 39, distanceMeters: 800 },
};

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

it("🔴 고른 대체 장소는 쉬는 날 · 이용시간을 불러 적는다", async () => {
  const spy = vi.spyOn(planApi, "placeDetail").mockResolvedValue({
    contentId: "2868676", hours: "11:00~20:00", restDays: "매주 월요일", fee: null, parking: null, eventPeriod: null,
  });
  await act(async () => root.render(<PatchDescription patch={replace} product={product} selected />));
  await settle();
  expect(spy).toHaveBeenCalledWith("2868676", 39);
  expect(host.textContent).toContain("쉬는 날 매주 월요일");
  expect(host.textContent).toContain("이용시간 11:00~20:00");
});

it("🔴 고르지 않은 후보는 부르지 않는다 — 후보마다 부르면 조회가 곱절이 된다", async () => {
  const spy = vi.spyOn(planApi, "placeDetail");
  await act(async () => root.render(<PatchDescription patch={replace} product={product} />));
  await settle();
  expect(spy).not.toHaveBeenCalled();
});

it("못 받으면 그렇다고 적는다", async () => {
  vi.spyOn(planApi, "placeDetail").mockRejectedValue(new TypeError("Failed to fetch"));
  await act(async () => root.render(<PatchDescription patch={replace} product={product} selected />));
  await settle();
  expect(host.textContent).toContain("운영 정보를 불러오지 못했어요.");
});
