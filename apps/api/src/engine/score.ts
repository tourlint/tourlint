import {
  PARTIAL_AUDIT_FAILURE_RATIO, READINESS_SCORE_BASE, SEVERITY, SEVERITY_WEIGHT_DEFAULT,
  type ReasonCode, type Severity,
} from '@tourlint/shared';

/**
 * 출시 준비도 산출 (FR-AU-040 ~ 049).
 *
 *   점수 = max(0, 100 − 차단×25 − 오류×10 − 주의×4 − 확인 불가×3)
 *
 * 순수 함수다. 같은 finding 목록과 같은 가중치면 언제나 같은 점수가 나온다 (NF-MT-001).
 *
 * **상품 규모로 정규화하지 않는다** (FR-AU-049). 12곳짜리와 8곳짜리를 같은 잣대로 잰다 —
 * 관광지가 많다고 문제 1건이 가벼워지지 않기 때문이다. 대신 화면에 대상 수를 함께 적는다.
 */

/** 출발 전 최종 확인 항목은 감점하지 않는다 (FR-AU-045) */
const NON_SCORING_REASONS: ReadonlySet<ReasonCode> = new Set(['PRE_DEPARTURE_CHECK']);

export interface ScorableFinding {
  readonly severity: Severity;
  readonly reasonCode: ReasonCode;
  /** 사용자가 무시했는가. `dismissed_at IS NOT NULL` 에 대응한다 */
  readonly dismissed: boolean;
  /** 확인 필요 목록에 올라 있는가 */
  readonly needsConfirmation: boolean;
}

export interface ScoreInput {
  readonly findings: readonly ScorableFinding[];
  /** 산출 시점 가중치. `audit_run.weight_snapshot` 에 그대로 저장한다 (DR-CF-006) */
  readonly weights?: Readonly<Record<Severity, number>>;
  /** 검수 대상 콘텐츠 수 */
  readonly targetCount: number;
  /** 확인 불가로 격리된 콘텐츠 수 */
  readonly failedCount?: number;
}

export interface ScoreResult {
  /** 부분 검수면 **null**. 점수를 내지 않는다 (FR-AU-029 · DR-IN-005) */
  readonly score: number | null;
  readonly isPartial: boolean;
  readonly counts: Readonly<Record<Severity, number>>;
  /** 감점에 실제로 쓰인 건수. `counts` 와 다를 수 있다 (무시 · 비감점 사유 제외) */
  readonly scoredCounts: Readonly<Record<Severity, number>>;
  /** 화면에 그대로 노출할 계산식 (FR-AU-043) */
  readonly breakdown: string;
  /** 차단이 1건이라도 있으면 점수와 무관하게 출시 불가 (FR-AU-042) */
  readonly releaseBlocked: boolean;
  /** 리포트에 "무시된 항목 N건" 으로 반드시 명시한다 (FR-AU-046) */
  readonly dismissedCount: number;
  /** 확인 필요 N건. **확인 불가 등급 건수와 다르다** (FR-AU-044) */
  readonly needsConfirmationCount: number;
  /**
   * 차단인데 무시 표시가 붙어 있는 건수.
   *
   * DB `ck_finding_blocker_not_dismissed` 가 막고 있어 0이어야 한다 (FR-AU-047 · PM-NG-001).
   * 0이 아니면 어딘가 우회 경로가 뚫린 것이므로 조용히 넘기지 않고 드러낸다.
   */
  readonly invalidDismissals: number;
}

export function calculateReadiness(input: ScoreInput): ScoreResult {
  const weights = input.weights ?? SEVERITY_WEIGHT_DEFAULT;
  const failedCount = input.failedCount ?? 0;

  const counts = zeroCounts();
  const scoredCounts = zeroCounts();
  let dismissedCount = 0;
  let needsConfirmationCount = 0;
  let invalidDismissals = 0;

  for (const f of input.findings) {
    counts[f.severity]++;
    if (f.needsConfirmation) needsConfirmationCount++;

    // 차단은 무시할 수 없다 (FR-AU-047). 무시 표시가 붙어 있어도 감점에서 빼지 않는다
    const dismissed = f.dismissed && f.severity !== 'BLOCKER';
    if (f.dismissed && f.severity === 'BLOCKER') invalidDismissals++;
    if (dismissed) {
      dismissedCount++;
      continue;
    }
    if (NON_SCORING_REASONS.has(f.reasonCode)) continue;

    scoredCounts[f.severity]++;
  }

  const releaseBlocked = counts.BLOCKER > 0;

  /*
   * FR-AU-029 — 실패 콘텐츠가 50% **를 넘으면** 부분 검수로 승격하고 점수를 내지 않는다.
   * 경계는 초과다. 8곳 중 4곳(50%)은 점수를 내고, 5곳(62.5%)은 내지 않는다.
   */
  const isPartial = input.targetCount > 0 && failedCount / input.targetCount > PARTIAL_AUDIT_FAILURE_RATIO;

  const deduction = SEVERITY.reduce((sum, s) => sum + scoredCounts[s] * (weights[s] ?? 0), 0);
  const score = isPartial ? null : Math.max(0, READINESS_SCORE_BASE - deduction);

  return {
    score,
    isPartial,
    counts,
    scoredCounts,
    breakdown: formatBreakdown(scoredCounts, weights, score),
    releaseBlocked,
    dismissedCount,
    needsConfirmationCount,
    invalidDismissals,
  };
}

/**
 * 감점 계산식을 그대로 노출한다 (FR-AU-043).
 *
 *   `100 − (2×25) − (1×10) − (2×4) − (1×3) = 29점`
 *
 * 건수가 0인 등급도 적는다 — 식이 빠지면 사용자가 "왜 이 점수인가" 를 되짚을 수 없다.
 */
export function formatBreakdown(
  counts: Readonly<Record<Severity, number>>,
  weights: Readonly<Record<Severity, number>>,
  score: number | null,
): string {
  const terms = SEVERITY.map((s) => `(${counts[s]}×${weights[s] ?? 0})`).join(' − ');
  return score === null
    ? `${READINESS_SCORE_BASE} − ${terms} = 점수 미산출 (부분 검수)`
    : `${READINESS_SCORE_BASE} − ${terms} = ${score}점`;
}

function zeroCounts(): Record<Severity, number> {
  return { BLOCKER: 0, ERROR: 0, WARNING: 0, UNVERIFIED: 0 };
}
