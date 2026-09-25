import { LCLS_SYSTM2, READINESS_SCORE_BASE, type Severity } from '@tourlint/shared';
import { KAKAO_SOURCE } from '../engine/rules/r08-travel';
import type { StoredAuditRun } from '../persistence/audit-result.repository';

/**
 * 전후 비교 지표 한 줄 (FR-PA-040). 대부분 before · after 숫자지만 총 감점은 계산식을,
 * 이동시간 · 거리는 출처를, 수요 적합성은 문장을 함께 준다.
 */
export interface ComparisonMetric {
  readonly key: string;
  readonly label: string;
  readonly before?: number | null;
  readonly after?: number | null;
  readonly beforeText?: string;
  readonly afterText?: string;
  readonly formulaBefore?: string;
  readonly formulaAfter?: string;
  readonly sourceBadge?: string;
  readonly externalSource?: string;
}

/**
 * 전후 비교 지표 (FR-PA-040 · 041). 화면 5 와 검수 리포트(FR-PA-043 · #806)가 같은 값을 쓴다 —
 * 따로 계산하면 같은 반영이 화면과 PDF 에서 다르게 보인다.
 */
export function comparisonMetrics(before: StoredAuditRun, after: StoredAuditRun): readonly ComparisonMetric[] {
  return [
    countMetric('blocker', '차단', before, after, 'BLOCKER'),
    countMetric('error', '오류', before, after, 'ERROR'),
    countMetric('warning', '주의', before, after, 'WARNING'),
    countMetric('unverified', '확인 불가', before, after, 'UNVERIFIED'),
    {
      key: 'deduction', label: '총 감점',
      before: deductionOf(before), after: deductionOf(after),
      // 점수를 화면에서 검산할 수 있어야 한다 (FR-PA-041 · FR-AU-043)
      formulaBefore: before.current.breakdown,
      formulaAfter: after.current.breakdown,
    },
    {
      key: 'readinessScore', label: '출시 준비도',
      before: before.current.score, after: after.current.score,
    },
    ...travelMetrics(before, after),
    targetFitMetric(before, after),
  ];
}

function countMetric(
  key: string, label: string,
  before: StoredAuditRun, after: StoredAuditRun, severity: Severity,
): ComparisonMetric {
  return { key, label, before: before.current.counts[severity], after: after.current.counts[severity] };
}

/** 총 감점 = 100 − 준비도. 부분 검수는 점수가 없어 감점도 없다 (FR-AU-029) */
function deductionOf(run: StoredAuditRun): number | null {
  return run.current.score === null ? null : READINESS_SCORE_BASE - run.current.score;
}

/**
 * 총 이동시간 · 거리 (FR-RU-084).
 *
 * **산출하지 않은 실행은 지표 자체를 내지 않는다.** 0 으로 채우면 「이동이 없었다」로
 * 읽히고, 전후 한쪽만 0 이면 개선된 것처럼 보인다. 이 컬럼이 생기기 전 실행이 그렇다.
 */
function travelMetrics(before: StoredAuditRun, after: StoredAuditRun): ComparisonMetric[] {
  if (before.travelTotals === null || after.travelTotals === null) return [];
  const badge = { sourceBadge: 'EXTERNAL_REF', externalSource: KAKAO_SOURCE };
  return [
    {
      key: 'travelMinutes', label: '총 이동시간',
      before: Math.round(before.travelTotals.durationSeconds / 60),
      after: Math.round(after.travelTotals.durationSeconds / 60),
      ...badge,
    },
    {
      key: 'travelMeters', label: '총 이동거리',
      before: before.travelTotals.distanceMeters, after: after.travelTotals.distanceMeters,
      ...badge,
    },
  ];
}

/**
 * 수요 적합성 — R10 결손 유형 (FR-PA-040).
 *
 * ⚠️ 판매량 · 시장 반응 · 흥행을 말하지 않는다 (FR-RU-104). R10 이 낸 문장을 그대로 옮긴다.
 */
function targetFitMetric(before: StoredAuditRun, after: StoredAuditRun): ComparisonMetric {
  return {
    key: 'targetFit', label: '수요 적합성',
    beforeText: targetFitText(before), afterText: targetFitText(after),
  };
}

function targetFitText(run: StoredAuditRun): string {
  const r10 = run.findings.find((f) => f.ruleCode === 'R10' && !f.dismissed);
  if (r10 === undefined) return '결손 유형 없음';
  const missing = r10.evidence.missingLcls2;
  if (!Array.isArray(missing) || missing.length === 0) return r10.message;
  return missing.map((code) => LCLS_SYSTM2[String(code)]?.name ?? String(code)).join(' · ') + ' 없음';
}
