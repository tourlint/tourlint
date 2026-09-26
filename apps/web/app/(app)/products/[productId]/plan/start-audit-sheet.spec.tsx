// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditApi, productApi } from "../../../../lib/api";
import { findForbidden } from "../../../../lib/screen-words";
import { StartAuditSheet } from "./start-audit-sheet";

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

// 검수 시작 창의 429 — 분당 상한과 예산 소진을 가른다 (NF-SC-010 · EX-SY-008 · #867)
const tooFast = {
  status: 429, reasonCode: "RATE_LIMIT_EXCEEDED", retryAfterSeconds: 43,
  message: "검수는 1분에 5번까지 요청할 수 있어요. 43초 뒤에 다시 눌러 주세요.",
};
const budgetOut = {
  status: 429, reasonCode: "BUDGET_EXHAUSTED",
  message: "오늘 쓸 수 있는 관광정보 조회를 모두 썼습니다.",
};

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.spyOn(auditApi, "availability").mockResolvedValue({ available: true, reasonCode: null, resumesAt: null });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);

async function startWith(rejection: unknown) {
  vi.spyOn(productApi, "handoff").mockRejectedValue(rejection);
  await act(async () => root.render(<StartAuditSheet productId={69} pendingCount={0} />));
  await settle();
  await act(async () => button("검수 시작 →")!.click());
  await act(async () => button("검수 시작")!.click());
  await settle();
}

it("🔴 분당 상한에 걸리면 예산 소진이라고 하지 않는다 — 서버 문구를 보이고 다시 누를 수 있게 둔다", async () => {
  await startWith(tooFast);

  expect(host.textContent).toContain("43초 뒤에 다시 눌러 주세요.");
  expect(host.textContent).not.toContain("관광정보 조회를 모두 써서");
  expect(button("검수 시작")?.disabled).toBe(false);
  expect(router.push).not.toHaveBeenCalled();
});

it("예산 소진은 지금처럼 막고 다시 열리는 때를 적는다", async () => {
  await startWith(budgetOut);

  expect(host.textContent).toContain("관광정보 조회를 모두 써서 지금은 검수할 수 없어요.");
  expect(host.textContent).toContain("상품은 기획 중에 그대로 있어요.");
  expect(button("검수 시작")).toBeUndefined();
});

// 고르지 않은 곳이 남은 채 누르면 (UI-S2-023 · UI-S2-042 · EX-PL-005)
const lines = [
  { itemId: 5, day: 2, start: "09:00", place: "경포해변" },
  { itemId: 9, day: 3, start: "09:00", place: "" },
];
const labels = () => [...host.querySelectorAll("button")].map((b) => b.textContent);
const click = async (label: string) => act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === label)!.click());

describe("검수 시작 창 — 고르지 않은 곳 (UI-S2-023 · UI-S2-042 · EX-PL-005)", () => {
  it("🔴 고르지 않은 곳이 남았으면 그 목록과 세 버튼을 준다", async () => {
    await act(async () => root.render(<StartAuditSheet productId={70} pendingCount={2} pendingItems={lines} onFindAll={() => {}} />));
    await click("검수 시작 →");
    expect(host.textContent).toContain("2일차 · 09:00 · 경포해변");
    expect(host.textContent).toContain("3일차 · 09:00 · 이름 없는 줄");
    expect(labels()).toEqual(expect.arrayContaining(["돌아가기", "AI로 한 번에 찾기", "이대로 검수 시작"]));
    // 기획 화면에는 판정 말을 두지 않는다 (FR-PL-021)
    expect(findForbidden(host.innerHTML, true)).toEqual([]);
  });

  it("🔴 [AI로 한 번에 찾기]는 창을 닫고 찾기를 돌린다 — 검수는 시작하지 않는다", async () => {
    const handoff = vi.spyOn(productApi, "handoff");
    const findAll = vi.fn();
    await act(async () => root.render(<StartAuditSheet productId={70} pendingCount={2} pendingItems={lines} onFindAll={findAll} />));
    await click("검수 시작 →");
    await click("AI로 한 번에 찾기");
    expect(findAll).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain("검수를 시작할까요?");
    expect(handoff).not.toHaveBeenCalled();
  });

  it("모두 골랐으면 지금과 같다 — 목록 · AI 버튼 없이 [검수 시작] (가이드 10단계)", async () => {
    const handoff = vi.spyOn(productApi, "handoff").mockResolvedValue({ productId: 70, plannedAt: "", jobId: 1, excludedCount: 0 });
    await act(async () => root.render(<StartAuditSheet productId={70} pendingCount={0} pendingItems={[]} onFindAll={() => {}} />));
    await click("검수 시작 →");
    expect(labels()).toEqual(["검수 시작 →", "돌아가기", "검수 시작"]);
    await click("검수 시작");
    expect(handoff).toHaveBeenCalledWith(70, false);
  });
});
