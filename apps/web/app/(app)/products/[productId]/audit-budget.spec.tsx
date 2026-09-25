// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentApi, auditApi, planApi, productApi, type ProductDetail, type RunSummary } from "../../../lib/api";
import { AuditResult } from "./audit-result";
import { StartAuditSheet } from "./plan/start-audit-sheet";
import { PlanEditor } from "./plan/plan-editor";
import { ReviewPlaceDrawer } from "./review-place-drawer";

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

// 예산이 다 되면 검수 버튼을 누르기 전에 막고 다시 열리는 때를 적는다 (UI-ST-007 · EX-QT-002 · #838)
const closed = { available: false, reasonCode: "BUDGET_EXHAUSTED" as const, resumesAt: "2026-10-13T00:00:00+09:00" };
const open = { available: true, reasonCode: null, resumesAt: null };

const run: RunSummary = {
  auditRunId: 205, productId: 69, executedAt: "2026-10-12T20:30:00+09:00", rulesetVersion: "1.2.8", isPartial: false,
  readinessScore: 85, scoreBreakdown: { formula: null, deduction: 15, weights: { BLOCKER: 25, ERROR: 10, WARNING: 4, UNVERIFIED: 3 } },
  counts: { blocker: 0, error: 0, warning: 3, unverified: 1, dismissed: 0 }, needsConfirmationCount: 1,
  targetCount: 4, failedCount: 0, releasable: true, releaseBlockedReason: null, settingSnapshot: null,
  evidence: { fetchedAt: "2026-10-12T20:30:00+09:00", targetContentCount: 4, dataFingerprint: null, dataFingerprintFull: null,
    rulesetVersion: "1.2.8", ktoModifiedAt: null, delayNotice: "안내", source: "출처" },
};
const product = {
  productId: 69, name: "강릉 1박 2일", days: [], releasedAt: null, startDate: "2026-11-17", nights: 1, plannedAt: "2026-10-12",
  region: { regnName: "강원특별자치도", signguName: "강릉시" }, composition: { manual: 4, picker: 0, excluded: 0 },
  ldongRegnCd: "51", ldongSignguCd: "150", dayCount: 2,
} as unknown as ProductDetail;

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.spyOn(productApi, "detail").mockResolvedValue(product);
  vi.spyOn(auditApi, "listRuns").mockResolvedValue({ totalCount: 1, runs: [run] } as Awaited<ReturnType<typeof auditApi.listRuns>>);
  vi.spyOn(auditApi, "getRun").mockResolvedValue(run);
  vi.spyOn(auditApi, "getFindings").mockResolvedValue({ content: [] } as unknown as Awaited<ReturnType<typeof auditApi.getFindings>>);
  vi.spyOn(auditApi, "getUnverified").mockResolvedValue({ totalCount: 0, items: [] });
  vi.spyOn(agentApi, "checkQuestions").mockResolvedValue({ items: [] } as unknown as Awaited<ReturnType<typeof agentApi.checkQuestions>>);
  vi.spyOn(planApi, "briefing").mockResolvedValue({ region: { regnCd: "51", signguCd: "150", name: "강릉시" }, types: [], events: null, accessible: null, pet: null, walks: null, budget: "PAUSED" });
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
const notice = () => host.querySelector("[data-budget-blocked]")?.textContent ?? null;

describe("예산이 다 됐을 때", () => {
  it("🔴 기획 화면의 검수 시작을 누르기 전에 막고 다시 열리는 날을 적는다", async () => {
    vi.spyOn(auditApi, "availability").mockResolvedValue(closed);
    await act(async () => root.render(<StartAuditSheet productId={69} pendingCount={0} />));
    await settle();
    expect(button("검수 시작 →")?.disabled).toBe(true);
    expect(notice()).toContain("10월 13일 0시부터 다시 할 수 있어요");
    expect(notice()).toContain("일정 편집과 지난 결과는 지금도");
  });

  it("🔴 결과 화면의 지금 재검수를 막고 같은 안내를 둔다", async () => {
    vi.spyOn(auditApi, "availability").mockResolvedValue(closed);
    await act(async () => root.render(<AuditResult productId={69} />));
    await settle();
    expect(button("지금 재검수")?.disabled).toBe(true);
    expect(notice()).toContain("10월 13일 0시부터");
  });

  it("🔴 장소 담기 서랍의 담은 일정 재검수도 막는다 — 담는 것은 그대로다", async () => {
    await act(async () => root.render(
      <ReviewPlaceDrawer product={product} context={{}} changed onInserted={async () => {}} onClose={() => {}} onReaudit={() => {}}
        reauditBlocked resumesAt={closed.resumesAt} />,
    ));
    await settle();
    const reaudit = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "담은 일정 재검수");
    expect(reaudit?.disabled).toBe(true);
    expect(document.querySelector("[data-budget-blocked]")?.textContent).toContain("10월 13일 0시부터");
  });
});

describe("장소 정보 한 줄 (UI-S2-043)", () => {
  it("🔴 예산이 다 돼 못 불렀으면 비워 두기만 하지 않고 까닭과 다시 볼 때를 적는다", async () => {
    vi.spyOn(auditApi, "availability").mockResolvedValue(open);
    const confirmed = { itemId: 1, seq: 1, start: "10:00", end: "11:30", place: "강릉 경포대", itemType: "SIGHT", ktoContentId: "125769", matchStatus: "CONFIRMED", mapx: 128.9, mapy: 37.79 };
    vi.spyOn(productApi, "detail").mockResolvedValue({ ...product, plannedAt: null, days: [{ day: 1, items: [confirmed] }] } as unknown as ProductDetail);
    vi.spyOn(planApi, "placeFacts").mockRejectedValue({
      status: 429, reasonCode: "BUDGET_EXHAUSTED",
      message: "오늘 쓸 수 있는 관광정보 조회를 모두 썼습니다. 내일 0시부터 다시 볼 수 있고, 일정 입력과 저장은 지금도 할 수 있습니다.",
    });
    vi.spyOn(planApi, "events").mockResolvedValue({ window: { from: "2026-11-17", to: "2026-11-18" }, items: [] } as unknown as Awaited<ReturnType<typeof planApi.events>>);
    vi.spyOn(planApi, "walks").mockResolvedValue({ items: [], notice: null } as unknown as Awaited<ReturnType<typeof planApi.walks>>);
    await act(async () => root.render(<PlanEditor productId={69} />));
    await settle();
    expect(notice()).toContain("내일 0시부터 다시 볼 수 있고");
  });
});

describe("예산이 남았을 때", () => {
  it("버튼을 막지 않고 안내도 없다", async () => {
    vi.spyOn(auditApi, "availability").mockResolvedValue(open);
    await act(async () => root.render(<StartAuditSheet productId={69} pendingCount={0} />));
    await settle();
    expect(button("검수 시작 →")?.disabled).toBe(false);
    expect(notice()).toBeNull();
  });

  it("묻지 못하면 막지 않는다 — 누르면 서버가 같은 문으로 막는다", async () => {
    vi.spyOn(auditApi, "availability").mockRejectedValue(new TypeError("Failed to fetch"));
    await act(async () => root.render(<StartAuditSheet productId={69} pendingCount={0} />));
    await settle();
    expect(button("검수 시작 →")?.disabled).toBe(false);
  });
});
