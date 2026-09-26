// @vitest-environment jsdom
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditApi, productApi, type AuditJob, type ProductDetail, type RunSummary } from "../../../lib/api";
import { AuditResult, FIRST_RUN_POLL_MS, FIRST_RUN_POLL_TRIES, POLL_MS, SummaryCard, followJob, reviewCell } from "./audit-result";

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

// 재검수 진행 상태 — 직전 점수는 확정처럼 적지 않고(UI-ST-002), 다시 열어도 이어 보며(UI-ST-003),
// 2초 간격으로 묻는다(FR-AU-022)

const run = (auditRunId: number, readinessScore: number): RunSummary => ({
  auditRunId, productId: 42, executedAt: "2026-09-26T10:00:00+09:00", rulesetVersion: "1.2.9", isPartial: false,
  readinessScore, scoreBreakdown: { formula: null, deduction: 100 - readinessScore, weights: { BLOCKER: 25, ERROR: 10, WARNING: 4, UNVERIFIED: 3 } },
  counts: { blocker: 0, error: 0, warning: 1, unverified: 0, dismissed: 0 }, needsConfirmationCount: 0,
  targetCount: 14, failedCount: 0, releasable: true, releaseBlockedReason: null, settingSnapshot: null,
  evidence: { fetchedAt: "2026-09-26T10:00:00+09:00", targetContentCount: 14, dataFingerprint: null, dataFingerprintFull: null,
    rulesetVersion: "1.2.9", ktoModifiedAt: null, delayNotice: "안내", source: "출처" },
});
const product = {
  productId: 42, name: "강릉 2박 3일", days: [], releasedAt: null, startDate: "2026-11-17", nights: 2, plannedAt: "2026-09-26",
  region: { regnName: "강원특별자치도", signguName: "강릉시" }, composition: { manual: 14, picker: 0, excluded: 0 },
} as unknown as ProductDetail;
const job = (over: Partial<AuditJob>): AuditJob => ({
  jobId: 77, status: "RUNNING", productId: 42, progress: { done: 5, total: 14, label: "14곳 중 5곳 조회 완료" }, auditRunId: null, ...over,
});

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.spyOn(productApi, "detail").mockResolvedValue(product);
  vi.spyOn(auditApi, "availability").mockResolvedValue({ available: true, reasonCode: null, resumesAt: null });
  vi.spyOn(auditApi, "getFindings").mockResolvedValue({ content: [], totalElements: 0 });
  vi.spyOn(auditApi, "getUnverified").mockResolvedValue({ totalCount: 0, items: [] });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

const score = () => host.querySelector(".audit-score");
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

describe("재검수 중에 다시 연 결과 화면 (UI-ST-003)", () => {
  it("🔴 도는 작업을 이어 폴링하고, 그동안 점수는 직전 결과로 흐리게 둔 뒤 끝나면 새 결과로 바꾼다", async () => {
    vi.spyOn(auditApi, "listRuns").mockResolvedValue({ totalCount: 1, runs: [{ ...run(8, 61), isCurrent: true }], activeJobId: 77 });
    const getRun = vi.spyOn(auditApi, "getRun").mockImplementation(async (id) => (id === 9 ? run(9, 85) : run(8, 61)));
    const getJob = vi.spyOn(auditApi, "getJob")
      .mockResolvedValueOnce(job({}))
      .mockResolvedValue(job({ status: "DONE", auditRunId: 9, progress: { done: 14, total: 14, label: "14곳 중 14곳 조회 완료" } }));
    vi.useFakeTimers();
    await act(async () => root.render(<AuditResult productId={42} />));

    expect(getJob).toHaveBeenCalledWith(77);
    expect(score()?.getAttribute("data-stale")).toBe("true");
    expect(score()?.textContent).toContain("출시 준비도 · 직전 결과");
    expect(host.querySelector(".audit-lifecycle")?.textContent).toContain("직전 결과 61점 · 다시 검수하고 있어요");
    expect(host.querySelector(".audit-progress")?.textContent).toBe("14곳 중 5곳 조회 완료");
    expect(button("검수 중…")?.disabled).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS + 50); });
    expect(getRun).toHaveBeenLastCalledWith(9);
    expect(score()?.getAttribute("data-stale")).toBeNull();
    expect(score()?.textContent).toContain("85");
    expect(host.textContent).not.toContain("직전 결과");
  });

  it("도는 작업이 없으면 묻지 않는다", async () => {
    vi.spyOn(auditApi, "listRuns").mockResolvedValue({ totalCount: 1, runs: [{ ...run(8, 61), isCurrent: true }], activeJobId: null });
    vi.spyOn(auditApi, "getRun").mockResolvedValue(run(8, 61));
    const getJob = vi.spyOn(auditApi, "getJob");
    await act(async () => root.render(<AuditResult productId={42} />));
    expect(getJob).not.toHaveBeenCalled();
    expect(score()?.getAttribute("data-stale")).toBeNull();
  });
});

describe("폴링 간격 (FR-AU-022)", () => {
  it("🔴 지금 재검수는 작업을 만든 응답의 2초 간격으로 묻는다 — GET 응답에 힌트가 없다고 1.5초로 돌지 않는다", async () => {
    vi.spyOn(auditApi, "listRuns").mockResolvedValue({ totalCount: 1, runs: [{ ...run(8, 61), isCurrent: true }] });
    vi.spyOn(auditApi, "getRun").mockResolvedValue(run(8, 61));
    vi.spyOn(auditApi, "runAudit").mockResolvedValue(job({ jobId: 5, status: "QUEUED", pollIntervalMs: 2000 }));
    const getJob = vi.spyOn(auditApi, "getJob")
      .mockResolvedValueOnce(job({ jobId: 5 }))
      .mockResolvedValue(job({ jobId: 5, status: "DONE", auditRunId: 8 }));
    vi.useFakeTimers();
    await act(async () => root.render(<AuditResult productId={42} />));
    await act(async () => button("지금 재검수")!.click());

    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(getJob).toHaveBeenCalledTimes(1);
    expect(score()?.getAttribute("data-stale")).toBe("true");
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(getJob).toHaveBeenCalledTimes(2);
    expect(score()?.getAttribute("data-stale")).toBeNull();
  });

  it("🔴 첫 결과 대기도 2초 간격이고 1분에서 그친다", () => {
    expect(POLL_MS).toBe(2000);
    expect(FIRST_RUN_POLL_MS).toBe(2000);
    expect(FIRST_RUN_POLL_MS * FIRST_RUN_POLL_TRIES).toBe(60_000);
  });
});

describe("진행 표기와 실패 문구", () => {
  it("🔴 실패하면 사유코드 대신 사용자 말로 알린다", async () => {
    const failed = async () => job({ status: "FAILED", errorCode: "AUDIT_TIMEOUT" });
    const e = await followJob(77, { cancelled: () => false, onProgress: () => {} }, failed, async () => {}).catch((x: unknown) => x);
    expect((e as Error).message).toBe("검수가 30분 안에 끝나지 않아 멈췄습니다. 다시 검수해 주세요.");
    const other = await followJob(77, { cancelled: () => false, onProgress: () => {} }, async () => job({ errorCode: "INTERNAL_ERROR" }), async () => {})
      .catch((x: unknown) => x);
    expect((other as Error).message).not.toContain("INTERNAL_ERROR");
  });

  it("🔴 요약 카드와 라이프사이클 바는 재검수 중 「직전 결과」라고 적는다", () => {
    const html = renderToStaticMarkup(<SummaryCard run={run(8, 61)} confirmationCount={0} rechecking />);
    expect(html).toContain("출시 준비도 · 직전 결과");
    expect(html).toContain('data-stale="true"');
    expect(renderToStaticMarkup(<SummaryCard run={run(8, 61)} confirmationCount={0} />)).not.toContain("직전 결과");
    expect(reviewCell(run(8, 61), true)).toBe("직전 결과 61점 · 다시 검수하고 있어요");
    expect(reviewCell(run(8, 61))).toBe("61점 · 출시할 수 있어요");
  });
});
