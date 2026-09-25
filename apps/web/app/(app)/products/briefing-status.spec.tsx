// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { planApi, type PlanBriefing, type ProductDetail } from "../../lib/api";
import { PlacePicker } from "./[productId]/plan/place-picker";
import { RegisterPlacePicker } from "./new/register-place-picker";

// 장소 담기가 종류 목록을 못 받았을 때 (#822)
const briefing: PlanBriefing = {
  region: { regnCd: "51", signguCd: "150", name: "강릉시" },
  types: [{ kind: "LCLS2", lcls2: "VE01", nearKind: null, name: "랜드마크관광", count: 6, disabled: null }],
  events: null, accessible: null, pet: null, walks: null, budget: "OK",
};
// 공사 오류가 아니라 네트워크에서 끊긴 경우 — fetch 가 TypeError 를 던진다
const dropped = () => new TypeError("Failed to fetch");

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.spyOn(planApi, "places").mockResolvedValue({ scope: { kind: "LCLS2", label: "강릉시 전체" }, totalCount: 0, items: [], notice: null });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);

const register = (startDate: string) => (
  <RegisterPlacePicker regnCd="51" signguCd="150" startDate={startDate} nights={2} regionLabel="강릉시"
    anchor={null} schedule={[[], [], []]} onInsert={() => {}} />
);

it("🔴 등록 화면 — 못 받으면 멈춰 있지 않고 다시 불러오기를 준다", async () => {
  vi.spyOn(planApi, "briefing").mockRejectedValueOnce(dropped()).mockResolvedValueOnce(briefing);
  await act(async () => root.render(register("2026-11-17")));
  await settle();
  expect(host.textContent).toContain("종류를 불러오지 못했어요.");
  expect(host.textContent).not.toContain("불러오는 중…");

  await act(async () => button("다시 불러오기")!.click());
  await settle();
  expect(button("랜드마크관광6")).toBeDefined();
  expect(host.textContent).not.toContain("종류를 불러오지 못했어요.");
});

it("🔴 등록 화면 — 다시 받은 뒤에는 앞선 실패 문구를 목록 위에 남기지 않는다", async () => {
  vi.spyOn(planApi, "briefing").mockRejectedValueOnce(dropped()).mockResolvedValueOnce(briefing);
  await act(async () => root.render(register("2026-11-17")));
  await settle();
  // 출발일을 바꾸면 다시 부른다
  await act(async () => root.render(register("2026-11-18")));
  await settle();
  await act(async () => button("랜드마크관광6")!.click());
  await settle();
  expect(host.textContent).toContain("강릉시 전체");
  expect(host.textContent).not.toContain("종류를 불러오지 못했어요.");
});

it("🔴 기획 화면 — 못 받으면 다시 불러오기를 준다", async () => {
  vi.spyOn(planApi, "briefing").mockRejectedValueOnce(dropped()).mockResolvedValueOnce(briefing);
  const product = {
    productId: 68, ldongRegnCd: "51", ldongSignguCd: "150", startDate: "2026-11-17", nights: 2, dayCount: 3, days: [],
  } as unknown as ProductDetail;
  await act(async () => root.render(<PlacePicker product={product} onInserted={async () => {}} showExtras={false} />));
  await settle();
  expect(host.textContent).toContain("종류를 불러오지 못했어요.");
  expect(host.textContent).not.toContain("불러오는 중…");

  await act(async () => button("다시 불러오기")!.click());
  await settle();
  expect(host.textContent).toContain("랜드마크관광");
  expect(host.textContent).not.toContain("종류를 불러오지 못했어요.");
});
