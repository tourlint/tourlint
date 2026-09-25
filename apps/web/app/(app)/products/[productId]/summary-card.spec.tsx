import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { RunSummary } from "../../../lib/api";
import { SummaryCard } from "./audit-result";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

// 점수 옆 계산 문장은 점수와 더해서 맞아야 한다 (UI-S3-010 · FR-AU-046 · #819)
const run = (over: Partial<RunSummary>): RunSummary => ({
  auditRunId: 193, productId: 67, executedAt: "2026-09-25T21:40:00+09:00", rulesetVersion: "1.2.8", isPartial: false,
  readinessScore: 89,
  scoreBreakdown: {
    formula: "100 − (0×25) − (0×10) − (2×4) − (1×3) = 89점", deduction: 11,
    weights: { BLOCKER: 25, ERROR: 10, WARNING: 4, UNVERIFIED: 3 },
    scoredCounts: { blocker: 0, error: 0, warning: 2, unverified: 1 },
  },
  counts: { blocker: 0, error: 0, warning: 2, unverified: 1, dismissed: 1 },
  needsConfirmationCount: 1, targetCount: 14, failedCount: 0, releasable: true, releaseBlockedReason: null,
  settingSnapshot: null,
  evidence: {
    fetchedAt: "2026-09-25T21:40:00+09:00", targetContentCount: 14, dataFingerprint: "3d8bbf5d", dataFingerprintFull: null,
    rulesetVersion: "1.2.8", ktoModifiedAt: null, delayNotice: "안내", source: "출처: ⓒ한국관광공사",
  },
  ...over,
});

it("무시한 항목은 계산에서 빠지고 따로 적는다", () => {
  const html = renderToStaticMarkup(<SummaryCard run={run({})} confirmationCount={1} />);
  expect(html).toContain("100점에서 주의 2건 −8점, 확인 불가 1건 −3점");
  expect(html).toContain("무시 1건은 감점에서 제외됐어요.");
});

it("🔴 감점하지 않는 출발 임박 확인은 계산 문장에 넣지 않는다", () => {
  // 주의 3건 중 1건이 출발 전 운영기관 최종 확인이다 (FR-AU-045)
  const html = renderToStaticMarkup(
    <SummaryCard run={run({ counts: { blocker: 0, error: 0, warning: 3, unverified: 1, dismissed: 0 } })} confirmationCount={2} />,
  );
  expect(html).toContain("100점에서 주의 2건 −8점, 확인 불가 1건 −3점");
  expect(html).not.toContain("주의 3건");
});
