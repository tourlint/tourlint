// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentApi, auditApi, productApi, type ProductDetail, type RunSummary, type UnverifiedItem } from "../../../lib/api";
import { AuditResult } from "./audit-result";

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

// 출발 전 운영기관 최종 확인 (FR-AU-085 · UI-S3-035 · #808)
const run: RunSummary = {
  auditRunId: 7, productId: 3, executedAt: "2026-09-25T20:30:00", rulesetVersion: "1.2.8", isPartial: false,
  readinessScore: 44, scoreBreakdown: { formula: null, deduction: 56, weights: { BLOCKER: 25, ERROR: 10, WARNING: 4, UNVERIFIED: 3 } },
  counts: { blocker: 1, error: 2, warning: 3, unverified: 1, dismissed: 0 }, needsConfirmationCount: 2,
  targetCount: 8, failedCount: 0, releasable: false, releaseBlockedReason: null, settingSnapshot: null,
  evidence: { fetchedAt: "2026-09-25T20:30:00", targetContentCount: 8, dataFingerprint: null, dataFingerprintFull: null,
    rulesetVersion: "1.2.8", ktoModifiedAt: null, delayNotice: "안내", source: "출처" },
};
const departure: UnverifiedItem = {
  findingId: 90, contentid: null, placeLabel: null,
  reason: "출발 전 운영기관 최종 확인 — 내일 출발합니다. 관광정보는 바뀐 내용이 다음 날 반영되므로 방문할 곳의 운영 여부를 운영기관에 한 번 더 확인해 주세요.",
  reasonCode: "PRE_DEPARTURE_CHECK", location: null, confirmedAt: null, excludedFromScore: true,
  note: "출발이 가까워 자동으로 올린 항목이며 감점하지 않습니다", targetItemId: null,
};
const restDay: UnverifiedItem = {
  findingId: 91, contentid: "2465063", placeLabel: "갈골한과체험전시관", reason: "갈골한과체험전시관 — 휴무일 정보를 확인할 수 없습니다",
  reasonCode: "REST_DAY_UNCERTAIN", location: { dayNo: 1, seq: 1, startTime: "09:00" }, confirmedAt: null,
  excludedFromScore: false, note: null, targetItemId: 11,
};

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.spyOn(productApi, "detail").mockResolvedValue({
    productId: 3, name: "강릉 감성 1박 2일", days: [], releasedAt: null, startDate: "2026-09-26", nights: 1,
    region: { regnName: "강원특별자치도", signguName: "강릉시" }, composition: { manual: 8, picker: 0, excluded: 0 },
  } as unknown as ProductDetail);
  vi.spyOn(auditApi, "listRuns").mockResolvedValue({ totalCount: 1, runs: [run] } as Awaited<ReturnType<typeof auditApi.listRuns>>);
  vi.spyOn(auditApi, "getRun").mockResolvedValue(run);
  vi.spyOn(auditApi, "getFindings").mockResolvedValue({ content: [] } as unknown as Awaited<ReturnType<typeof auditApi.getFindings>>);
  vi.spyOn(auditApi, "getUnverified").mockResolvedValue({ totalCount: 2, items: [departure, restDay] });
  vi.spyOn(agentApi, "checkQuestions").mockResolvedValue({ items: [] } as unknown as Awaited<ReturnType<typeof agentApi.checkQuestions>>);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("🔴 출발 임박 항목은 상품 전체 · 감점 제외로 적고, 펼칠 관광정보가 없으니 판단 근거를 두지 않는다", async () => {
  await act(async () => root.render(<AuditResult productId={3} />));
  const rows = [...host.querySelectorAll("#audit-confirmations li")].filter((li) => li.textContent?.includes("확인"));
  const departureRow = rows.find((li) => li.textContent?.includes("출발 전 운영기관 최종 확인"));
  const restDayRow = rows.find((li) => li.textContent?.includes("휴무일 정보를 확인할 수 없습니다"));
  expect(departureRow?.textContent).toContain("상품 전체 · 감점 제외");
  expect(departureRow?.textContent).toContain("감점하지 않습니다");
  expect(departureRow?.textContent).not.toContain("판단 근거");
  // 관광정보가 붙은 줄은 그대로 펼칠 수 있다
  expect(restDayRow?.textContent).toContain("판단 근거");
});
