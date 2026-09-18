import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { filterFindings } from "./finding-filter";
import { SummaryCard } from "./audit-result";
import type { Finding, RunSummary, Severity } from "../../../lib/api";
function finding(id: number, severity: Severity, dismissed = false): Finding {
  return { findingId: id, severity, dismissedAt: dismissed ? "2026-09-18" : null } as Finding;
}
const items = [finding(4, "WARNING"), finding(1, "BLOCKER", true), finding(2, "ERROR"), finding(3, "BLOCKER"), finding(5, "UNVERIFIED")];
const run: RunSummary = {
  auditRunId: 1, productId: 42, executedAt: "2026-09-18T10:00:00", rulesetVersion: "1.2", isPartial: false,
  readinessScore: 42, scoreBreakdown: { formula: null, deduction: 58, weights: { BLOCKER: 25, ERROR: 10, WARNING: 4, UNVERIFIED: 3 } },
  counts: { blocker: 0, error: 4, warning: 0, unverified: 6, dismissed: 0 }, needsConfirmationCount: 8,
  targetCount: 10, failedCount: 0, releasable: true, releaseBlockedReason: null, settingSnapshot: null,
  evidence: { fetchedAt: "2026-09-18T10:00:00", targetContentCount: 10, dataFingerprint: null, dataFingerprintFull: null,
    rulesetVersion: "1.2", ktoModifiedAt: null, delayNotice: "안내", source: "출처" },
};
describe("검수 항목 분류", () => {
  it("미해결 심각도 순으로 정렬하고 무시한 항목은 마지막에 보존한다", () => {
    expect(filterFindings(items, "ALL").map(f => f.findingId)).toEqual([3, 2, 4, 5, 1]);
    expect(items.map(f => f.findingId)).toEqual([4, 1, 2, 3, 5]);
  });
  it("등급 건수에는 무시한 항목을 넣지 않고 별도 필터에서 볼 수 있다", () => {
    expect(filterFindings(items, "BLOCKER").map(f => f.findingId)).toEqual([3]);
    expect(filterFindings(items, "DISMISSED").map(f => f.findingId)).toEqual([1]);
    expect(filterFindings(items, "UNVERIFIED").map(f => f.findingId)).toEqual([5]);
  });
});
describe("검수 요약의 서버 판정 보존", () => {
  it("낮은 점수만으로 출시 불가를 만들어내지 않는다", () => {
    const html = renderToStaticMarkup(<SummaryCard run={run} confirmationCount={8} />);
    expect(html).toContain("출시할 수 있는 상품이에요");
    expect(html).toContain("<strong>42</strong>");
    expect(html).toContain("<strong>8건</strong>");
  });
  it("부분 검수는 숫자 점수를 숨기고 실제 실패 건수를 표시한다", () => {
    const html = renderToStaticMarkup(<SummaryCard run={{ ...run, isPartial: true, releasable: false, failedCount: 2 }} confirmationCount={8} />);
    expect(html).not.toContain("<strong>42</strong>");
    expect(html).toContain("조회하지 못한 콘텐츠 2곳");
  });
});
