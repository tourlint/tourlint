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

/** 등급 순(기본) · 일정 순서 (FR-AU-066 · UI-S3-020) */
export type FindingSort = "SEVERITY" | "SCHEDULE";
export const FINDING_SORTS: { value: FindingSort; label: string }[] = [
  { value: "SEVERITY", label: "등급 순" },
  { value: "SCHEDULE", label: "일정 순서" },
];

/** 이 건수를 넘으면 「전체」에서 주의 · 확인 불가를 접어 둔다 (FR-AU-067 · UI-S3-021) */
export const COLLAPSE_OVER = 20;
export const COLLAPSIBLE: readonly Severity[] = ["WARNING", "UNVERIFIED"];

const ORDER: Record<Severity, number> = { BLOCKER: 0, ERROR: 1, WARNING: 2, UNVERIFIED: 3 };

/** 일정 속 자리 — 일차 · 시각 · 순번. 대상이 없는 상품 전체 판정(R04 · R10 등)은 null */
function slot(f: Finding): { day: number; time: string; seq: number } | null {
  const t = f.target;
  if (t?.itemId == null || t.dayNo === undefined) return null;
  return { day: t.dayNo, time: t.startTime ?? "", seq: t.seq ?? 0 };
}

/** 일정 속 자리 순. 자리가 없는 판정은 뒤로 간다 */
function bySlot(a: Finding, b: Finding): number {
  const x = slot(a);
  const y = slot(b);
  if (x === null || y === null) return Number(x === null) - Number(y === null);
  return x.day - y.day || x.time.localeCompare(y.time) || x.seq - y.seq;
}

export function filterFindings(findings: Finding[], filter: FindingFilter, sort: FindingSort = "SEVERITY"): Finding[] {
  return findings.filter((f) => filter === "ALL" || (filter === "DISMISSED"
    ? f.dismissedAt !== null : f.dismissedAt === null && f.severity === filter))
    .sort((a, b) => Number(a.dismissedAt !== null) - Number(b.dismissedAt !== null)
      || (sort === "SEVERITY"
        ? ORDER[a.severity] - ORDER[b.severity] || bySlot(a, b)
        : bySlot(a, b) || ORDER[a.severity] - ORDER[b.severity])
      || a.findingId - b.findingId);
}
