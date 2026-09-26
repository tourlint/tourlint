// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { planApi, type PlanPlace, type PlanPlaceDetail } from "../../lib/api";
import { PlaceDetailView } from "./place-detail-view";

// 장소 「자세히」의 무장애 · 반려동물 조건 (UI-S2-040 · #850). 기능설명서는 두 서비스의 상세
// 오퍼레이션으로 「펼친 장소 카드의 동반 조건 · 무장애 정보」를 보인다고 적었다.

const place = (over: Partial<PlanPlace> = {}): PlanPlace => ({
  contentId: "129784", contentTypeId: 14, lcls1: "VE", lcls2: "VE07", lcls2Name: "전시시설",
  title: "오죽헌", addr1: "강원특별자치도 강릉시 율곡로3139번길 24", firstImage: null,
  mapx: null, mapy: null, distanceM: null, togetherRank: null,
  wheelchair: null, pet: null, indoorOutdoor: null, ...over,
});

const detail = (over: Partial<PlanPlaceDetail> = {}): PlanPlaceDetail => ({
  contentId: "129784", hours: "09:00~18:00", restDays: null, fee: null, parking: null, eventPeriod: null,
  contact: "033-660-3301", ...over,
});

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

it("🔴 무장애 · 반려동물로 표시된 곳은 그 축의 상세를 함께 부르고 조건을 이름표와 적는다", async () => {
  const spy = vi.spyOn(planApi, "placeDetail").mockResolvedValue(detail({
    accessible: { wheelchair: "대여 가능(5대/매표소 발권 후 우측에 보관함)", elevator: "엘리베이터 있음", braileblock: "" },
    pet: { acmpyTypeCd: "전구역 동반가능", acmpyNeedMtr: "목줄 착용" },
  }));
  await act(async () => root.render(<PlaceDetailView place={place({ wheelchair: true, pet: true })} />));
  await settle();

  expect(spy).toHaveBeenCalledWith("129784", 14, { accessible: true, pet: true });
  const text = host.textContent ?? "";
  expect(text).toContain("휠체어 대여 가능(5대/매표소 발권 후 우측에 보관함)");
  expect(text).toContain("엘리베이터 엘리베이터 있음");
  expect(text).toContain("동반 구분 전구역 동반가능");
  expect(text).toContain("동반 시 필요 사항 목줄 착용");
  // 빈 항목과 영어 필드 이름은 나가지 않는다 (UI-CM-040)
  expect(text).not.toContain("점자블록");
  expect(text).not.toContain("acmpy");
  // 목록이 알려 준 한 줄은 상세가 있으면 대신하지 않는다
  expect(text).not.toContain("무장애 편의 있음");
});

it("표시되지 않은 축은 부르지 않는다", async () => {
  const spy = vi.spyOn(planApi, "placeDetail").mockResolvedValue(detail());
  await act(async () => root.render(<PlaceDetailView place={place({ wheelchair: true, pet: false })} />));
  await settle();
  expect(spy).toHaveBeenCalledWith("129784", 14, { accessible: true, pet: false });
});

it("🔴 상세를 못 받으면 목록이 알려 준 한 줄로 줄인다 (EX-PL-004)", async () => {
  vi.spyOn(planApi, "placeDetail").mockResolvedValue(detail({ accessible: null, pet: null }));
  await act(async () => root.render(<PlaceDetailView place={place({ wheelchair: true, pet: true })} />));
  await settle();
  const text = host.textContent ?? "";
  expect(text).toContain("무장애 편의 있음");
  expect(text).toContain("반려동물 동반 가능");
});

it("🔴 문의처를 적는다 (UI-S2-040)", async () => {
  vi.spyOn(planApi, "placeDetail").mockResolvedValue(detail());
  await act(async () => root.render(<PlaceDetailView place={place()} />));
  await settle();
  expect(host.textContent).toContain("문의 033-660-3301");
});
