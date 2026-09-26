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

// 타깃에 따라 앞에 오는 정보 (UI-S2-040)
const everything = detail({
  hours: "09:00~18:00", restDays: "매주 월요일", fee: "3,000원", parking: "가능(무료)", contact: "033-660-3301",
  accessible: { wheelchair: "대여 가능" }, pet: { acmpyTypeCd: "전구역 동반가능" },
});
const order = (text: string, labels: string[]) => labels.map((l) => text.indexOf(l));
const increasing = (xs: number[]) => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]!));

it("🔴 시니어 · 가족(아이 동반)은 무장애 편의가 맨 앞이다", async () => {
  vi.spyOn(planApi, "placeDetail").mockResolvedValue(everything);
  for (const target of ["SENIOR", "FAMILY_KIDS"]) {
    await act(async () => root.render(<PlaceDetailView key={target} place={place({ wheelchair: true, pet: true })} target={target} />));
    await settle();
    expect(increasing(order(host.textContent ?? "", ["무장애 편의", "이용시간", "쉬는 날", "요금", "주차", "문의", "반려동물 동반"])), target).toBe(true);
  }
});

it("🔴 단체 · 모임은 주차 · 요금이 앞이다", async () => {
  vi.spyOn(planApi, "placeDetail").mockResolvedValue(everything);
  await act(async () => root.render(<PlaceDetailView place={place({ wheelchair: true, pet: true })} target="GROUP" />));
  await settle();
  expect(increasing(order(host.textContent ?? "", ["주차", "요금", "이용시간", "쉬는 날", "문의", "무장애 편의", "반려동물 동반"]))).toBe(true);
});

it("그 밖의 타깃 · 타깃 없음은 지금 순서다", async () => {
  vi.spyOn(planApi, "placeDetail").mockResolvedValue(everything);
  for (const target of ["YOUTH_20S", null]) {
    await act(async () => root.render(<PlaceDetailView key={String(target)} place={place({ wheelchair: true, pet: true })} target={target} />));
    await settle();
    expect(increasing(order(host.textContent ?? "", ["이용시간", "쉬는 날", "요금", "주차", "문의", "무장애 편의", "반려동물 동반"])), String(target)).toBe(true);
  }
});
