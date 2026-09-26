// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { auditApi, productApi } from "../../../../lib/api";
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
