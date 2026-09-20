import { stageOf, type Stage } from "./stage-of";

export interface LatestAudit {
  executedAt: string;
  readinessScore: number | null;
  isPartial: boolean;
  releasable: boolean;
  counts: {
    blocker: number;
    error: number;
    warning: number;
    unverified: number;
  };
}

export interface WorkspaceProduct {
  productId: number;
  name: string;
  startDate: string;
  nights: number;
  region?: { regnName?: string; signguName?: string };
  latestAudit?: LatestAudit | null;
  plannedAt?: string | null;
  releasedAt?: string | null;
  pendingMatches?: number;
}

export type Workspace = "home" | "planning" | "review";
export type SortKey = "startDate" | "readiness" | "audited";

export const MAIN_NAV = [
  { href: "/", label: "홈", icon: "home" },
  { href: "/planning", label: "기획", icon: "plan" },
  { href: "/review", label: "검수", icon: "check" },
  { href: "/radar", label: "레이더", icon: "radar" },
] as const;

export function activeSection(pathname: string): string | null {
  if (pathname === "/") return "/";
  if (
    pathname === "/planning" ||
    pathname === "/products/new" ||
    /^\/products\/[^/]+\/plan(?:\/|$)/.test(pathname)
  )
    return "/planning";
  if (pathname === "/review" || pathname.startsWith("/products/"))
    return "/review";
  if (pathname === "/radar") return "/radar";
  return null;
}

export function productStage(p: WorkspaceProduct): Stage {
  return stageOf({
    plannedAt: p.plannedAt ?? null,
    releasedAt: p.releasedAt ?? null,
    latestAudit: p.latestAudit ?? null,
  });
}

/**
 * 카드 · 「기획 이어하기」가 여는 곳.
 *
 * 기획 중 상품은 **편집 화면**으로 간다 (#665). 장소 확정 화면(`/plan`)으로 보냈더니
 * 기본정보만 저장하고 들어온 사람은 오른쪽 장소 담기 말고는 할 수 있는 게 없었다 — 일정을
 * 손으로 채우지도, 타깃 · 콘셉트를 마저 고르지도 못했다. 편집 화면은 등록 화면과 같은
 * 2단이라 저장한 값을 그대로 이어서 채운다. 저장하면 `/plan` 으로 간다.
 */
export function productHref(p: WorkspaceProduct): string {
  return `/products/${p.productId}${productStage(p) === "PLANNING" ? "/edit" : ""}`;
}

export function belongsTo(p: WorkspaceProduct, workspace: Workspace): boolean {
  return (
    workspace === "home" ||
    (workspace === "planning"
      ? productStage(p) === "PLANNING"
      : productStage(p) !== "PLANNING")
  );
}

export function sortProducts(
  list: WorkspaceProduct[],
  key: SortKey,
): WorkspaceProduct[] {
  return [...list].sort((a, b) => {
    const date =
      a.startDate.localeCompare(b.startDate) || a.productId - b.productId;
    if (key === "readiness")
      return (
        (b.latestAudit?.readinessScore ?? -1) -
          (a.latestAudit?.readinessScore ?? -1) || date
      );
    if (key === "audited")
      return (
        (b.latestAudit?.executedAt ?? "").localeCompare(
          a.latestAudit?.executedAt ?? "",
        ) || date
      );
    return date;
  });
}

export function productHint(p: WorkspaceProduct): string {
  const a = p.latestAudit;
  switch (productStage(p)) {
    case "PLANNING":
      return (p.pendingMatches ?? 0) > 0
        ? `아직 고르지 않은 장소 ${p.pendingMatches}곳`
        : "일정을 이어서 완성해 보세요";
    case "REVIEW":
      return !a
        ? "첫 검수를 기다리고 있어요"
        : a.isPartial
          ? "부분 검수 · 결과를 확인해 주세요"
          : `차단 ${a.counts.blocker}건 · 확인이 필요해요`;
    case "RELEASABLE":
      return a?.isPartial
        ? "부분 검수 · 결과를 확인해 주세요"
        : a?.readinessScore != null
          ? `${a.readinessScore}점 · 출시할 수 있어요`
          : "출시할 수 있어요";
    case "RELEASED":
      return p.releasedAt ? `${p.releasedAt.slice(0, 10)} 출시` : "출시함";
  }
}

export function regionText(p: WorkspaceProduct): string {
  return (
    [p.region?.regnName, p.region?.signguName].filter(Boolean).join(" ") ||
    "지역 미지정"
  );
}

export function reviewFilter(
  value: string | string[] | undefined,
): Stage | "ALL" {
  return value === "REVIEW" || value === "RELEASABLE" || value === "RELEASED"
    ? value
    : "ALL";
}

/** 한국 날짜의 여행 종료일까지는 진행 중이다. 브라우저 시간대와 무관하다. */
export function koreaToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function isPastTrip(p: Pick<WorkspaceProduct, "startDate" | "nights">, today = koreaToday()): boolean {
  const end = new Date(`${p.startDate}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + p.nights);
  return end.toISOString().slice(0, 10) < today;
}
