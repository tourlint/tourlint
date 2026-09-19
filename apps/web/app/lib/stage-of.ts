// 상품이 지금 어느 단계인지 (UI-S1-010 · 기획서 4-1). 순수 함수라 화면과 따로 시험한다.
//
//   기획 중      plannedAt 이 없다 (아직 검수 시작을 안 눌렀다)
//   검수 중      검수를 시작했고 아직 출시 전인데, 검수를 안 돌렸거나 차단이 남았다
//   출시할 수 있음 검수를 시작했고 아직 출시 전이며 차단이 0 이다
//   출시함       releasedAt 이 있다

export type Stage = "PLANNING" | "REVIEW" | "RELEASABLE" | "RELEASED";

export interface StageInput {
  plannedAt: string | null;
  releasedAt: string | null;
  /** `releasable` 은 서버의 출시 판정이다 — 반영 뒤 재검수 전이면 차단이 0이어도 false 다 (#551) */
  latestAudit: { counts: { blocker: number }; releasable?: boolean } | null;
}

export function stageOf(p: StageInput): Stage {
  if (p.plannedAt === null) return "PLANNING";
  if (p.releasedAt !== null) return "RELEASED";
  const hasRun = p.latestAudit !== null;
  const blocker = p.latestAudit?.counts.blocker ?? 0;
  if (!hasRun || blocker > 0 || p.latestAudit?.releasable === false) return "REVIEW";
  return "RELEASABLE";
}

export const STAGE_LABEL: Record<Stage, string> = {
  PLANNING: "기획 중",
  REVIEW: "검수 중",
  RELEASABLE: "출시할 수 있음",
  RELEASED: "출시함",
};

/** 보드 칸 순서 */
export const STAGE_ORDER: readonly Stage[] = ["PLANNING", "REVIEW", "RELEASABLE", "RELEASED"];
