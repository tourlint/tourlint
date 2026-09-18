import type { Finding, Severity } from "../../../lib/api";

export type FindingFilter = "ALL" | Severity | "DISMISSED";
export const FINDING_FILTERS: { value: FindingFilter; label: string }[] = [
  { value: "ALL", label: "전체" },
  { value: "BLOCKER", label: "차단" },
  { value: "ERROR", label: "오류" },
  { value: "WARNING", label: "주의" },
  { value: "UNVERIFIED", label: "확인 불가" },
  { value: "DISMISSED", label: "무시한 항목" },
];
const ORDER: Record<Severity, number> = { BLOCKER: 0, ERROR: 1, WARNING: 2, UNVERIFIED: 3 };
export function filterFindings(findings: Finding[], filter: FindingFilter): Finding[] {
  return findings.filter((f) => filter === "ALL" || (filter === "DISMISSED"
    ? f.dismissedAt !== null : f.dismissedAt === null && f.severity === filter))
    .sort((a, b) => Number(a.dismissedAt !== null) - Number(b.dismissedAt !== null)
      || ORDER[a.severity] - ORDER[b.severity] || a.findingId - b.findingId);
}
