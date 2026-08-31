// 상태·출처·등급 배지 공통 컴포넌트 (UI-CM-010~023).
//
// 여러 화면(대시보드·검수 결과·레이더·비교)이 같은 배지를 쓰므로 한 곳에 모은다.
// 형태로 세 계열을 구분한다 — 등급/출처는 채운 배지, 상태는 테두리 배지다 (UI-CM-013).
// 등급 색은 globals.css 의 `--severity-*` 토큰만 참조한다. 여기서 색을 하드코딩하지
// 않는다 (UI-CM-021).

import type { Severity } from "../lib/api";

// ── 등급 (UI-CM-020~023) ──────────────────────────────────────────────
// 색상과 텍스트 라벨을 함께 쓴다. 색만으로 구분하지 않는다 (UI-CM-020).

const GRADE: Record<Severity, { label: string; bg: string; fg: string }> = {
  BLOCKER: { label: "차단", bg: "bg-[var(--severity-blocker-bg)]", fg: "text-[var(--severity-blocker-fg)]" },
  ERROR: { label: "오류", bg: "bg-[var(--severity-error-bg)]", fg: "text-[var(--severity-error-fg)]" },
  WARNING: { label: "주의", bg: "bg-[var(--severity-warning-bg)]", fg: "text-[var(--severity-warning-fg)]" },
  UNVERIFIED: { label: "확인 불가", bg: "bg-[var(--severity-unverified-bg)]", fg: "text-[var(--severity-unverified-fg)]" },
};

const GRADE_ORDER: Severity[] = ["BLOCKER", "ERROR", "WARNING", "UNVERIFIED"];

export function gradeLabel(grade: Severity): string {
  return GRADE[grade].label;
}

export function GradeBadge({ grade, className = "" }: { grade: Severity; className?: string }) {
  const g = GRADE[grade];
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${g.bg} ${g.fg} ${className}`}>
      {g.label}
    </span>
  );
}

export interface GradeCounts {
  blocker: number;
  error: number;
  warning: number;
  unverified: number;
}

function countOf(counts: GradeCounts, grade: Severity): number {
  switch (grade) {
    case "BLOCKER":
      return counts.blocker;
    case "ERROR":
      return counts.error;
    case "WARNING":
      return counts.warning;
    case "UNVERIFIED":
      return counts.unverified;
  }
}

/**
 * 등급별 건수. 0건인 등급도 숨기지 않고 항상 4개를 모두 표시한다 (UI-CM-023).
 *
 * `tile` 은 검수 결과 요약의 큰 칸, `chip` 은 목록 셀의 한 줄짜리다.
 */
export function GradeCounts({ counts, variant = "chip" }: { counts: GradeCounts; variant?: "tile" | "chip" }) {
  if (variant === "tile") {
    return (
      <div className="flex gap-2">
        {GRADE_ORDER.map((grade) => {
          const g = GRADE[grade];
          return (
            <div key={grade} className={`min-w-[64px] rounded-lg px-3 py-2 text-center ${g.bg} ${g.fg}`}>
              <div className="text-lg font-bold tabular-nums">{countOf(counts, grade)}</div>
              <div className="text-xs">{g.label}</div>
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {GRADE_ORDER.map((grade) => {
        const g = GRADE[grade];
        return (
          <span
            key={grade}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs tabular-nums ${g.bg} ${g.fg}`}
            title={g.label}
          >
            <span className="font-semibold">{countOf(counts, grade)}</span>
            <span className="opacity-70">{g.label}</span>
          </span>
        );
      })}
    </div>
  );
}

// ── 출처 배지 (UI-CM-010~012) ─────────────────────────────────────────
// 모든 정보 블록에 4종 중 하나가 붙는다. 채운 알약 형태로 상태 배지와 구분한다.

export type SourceKind = "KTO_ORIGINAL" | "TOURLINT_VERDICT" | "AI_NORMALIZED" | "EXTERNAL_REFERENCE";

const SOURCE: Record<SourceKind, { label: string; cls: string }> = {
  KTO_ORIGINAL: { label: "공사 원문", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300" },
  TOURLINT_VERDICT: { label: "TourLint 판정", cls: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300" },
  AI_NORMALIZED: { label: "AI 정규화", cls: "bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300" },
  EXTERNAL_REFERENCE: { label: "외부 참고", cls: "bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300" },
};

/**
 * 출처 배지. `외부 참고` 는 외부 서비스명을 함께 표기한다 (UI-CM-011). 저작권
 * 제3유형(Type3)이면 "변경금지" 를 함께 표기한다 (UI-CM-012). 배지 명칭은
 * 임의로 바꾸지 않는다 (용어 G-026).
 */
export function SourceBadge({
  source,
  externalName,
  restricted = false,
  className = "",
}: {
  source: SourceKind;
  externalName?: string | null;
  restricted?: boolean;
  className?: string;
}) {
  const s = SOURCE[source];
  const label = source === "EXTERNAL_REFERENCE" && externalName ? `${s.label} · ${externalName}` : s.label;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${s.cls} ${className}`}>
      {label}
      {restricted && <span className="rounded-sm bg-black/10 px-1 text-[10px] font-medium dark:bg-white/15">변경금지</span>}
    </span>
  );
}

// ── 상태 배지 (UI-CM-013) ─────────────────────────────────────────────
// 항목의 처리 상태. 테두리 형태로 출처 배지(채운 알약)와 구분한다. 출처 배지와
// 한 항목에 동시에 붙을 수 있다 (UI-CM-014).

export type StatusKind =
  | "EXCLUDED"
  | "NOT_RELEASABLE"
  | "PARTIAL"
  | "DISMISSED"
  | "DEFAULT_APPLIED"
  | "DISPLAY_STOPPED";

const STATUS: Record<StatusKind, { label: string; cls: string }> = {
  EXCLUDED: { label: "검수 제외", cls: "border-slate-300 text-slate-500 dark:border-slate-700 dark:text-slate-400" },
  NOT_RELEASABLE: { label: "출시 불가", cls: "border-rose-300 text-rose-700 dark:border-rose-800 dark:text-rose-300" },
  PARTIAL: { label: "부분 검수", cls: "border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300" },
  DISMISSED: { label: "무시됨", cls: "border-slate-300 text-slate-500 dark:border-slate-700 dark:text-slate-400" },
  DEFAULT_APPLIED: { label: "기본값 적용", cls: "border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300" },
  DISPLAY_STOPPED: { label: "표출 중단", cls: "border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300" },
};

export function StatusBadge({ status, className = "" }: { status: StatusKind; className?: string }) {
  const s = STATUS[status];
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${s.cls} ${className}`}>
      {s.label}
    </span>
  );
}
