import { SEVERITY_WEIGHT_DEFAULT, type Severity } from '@tourlint/shared';
import { describe, expect, it } from 'vitest';
import type { StoredAuditRun } from '../persistence/audit-result.repository';
import type { StoredPatchApplication } from '../persistence/patch-application.repository';
import { toComparisonResponse } from './audit.service';

/**
 * 전후 비교 응답 만들기 (F10 · API 설계 5-9).
 *
 * 관통 스펙(`audit.service.spec.ts`)은 실제 검수를 돌려 보는 자리라 **점수가 나빠지는
 * 경우나 이동값이 없는 옛 실행**을 만들 수가 없다. 그 갈래를 여기서 본다 —
 * `toComparisonResponse` 는 순수 함수다.
 */

const counts = (over: Partial<Record<Severity, number>> = {}): Record<Severity, number> =>
  ({ BLOCKER: 0, ERROR: 0, WARNING: 0, UNVERIFIED: 0, ...over });

interface RunSpec {
  readonly id?: number;
  readonly score?: number | null;
  readonly counts?: Partial<Record<Severity, number>>;
  readonly travel?: { durationSeconds: number; distanceMeters: number } | null;
}

function run(s: RunSpec = {}): StoredAuditRun {
  const c = counts(s.counts);
  const score = s.score === undefined ? 90 : s.score;
  return {
    id: s.id ?? 1,
    productId: 31,
    executedAt: new Date('2026-09-15T05:32:07Z'),
    rulesetVersion: '1.2.0',
    storedScore: score,
    isPartial: false,
    targetCount: 8,
    failedCount: 0,
    weights: SEVERITY_WEIGHT_DEFAULT,
    travelTotals: s.travel === undefined ? { durationSeconds: 11_400, distanceMeters: 86_000 } : s.travel,
    findings: [],
    current: {
      score, isPartial: false, counts: c, scoredCounts: c,
      breakdown: `100 − ${100 - (score ?? 0)}`,
      releaseBlocked: c.BLOCKER > 0, dismissedCount: 0,
      needsConfirmationCount: 0, invalidDismissals: 0,
    },
  };
}

const application: StoredPatchApplication = {
  id: 44, productId: 31,
  appliedAt: new Date('2026-09-15T05:41:00Z'), appliedBy: 1,
  selections: [{ findingId: 1, patchId: 'p-1' }],
  before: { snapshotVersion: 1, items: [] } as never,
  after: { snapshotVersion: 1, items: [] } as never,
  beforeAuditRunId: 812, afterAuditRunId: 815, revertedAt: null,
};

const metricsOf = (before: StoredAuditRun, after: StoredAuditRun): Record<string, unknown>[] =>
  toComparisonResponse(application, before, after).metrics as Record<string, unknown>[];

describe('이동 지표 (FR-RU-084)', () => {
  it('🔴 산출하지 않은 실행이 섞이면 지표 자체를 내지 않는다', () => {
    /*
     * 0 으로 채우면 「이동이 없었다」로 읽힌다. 전후 한쪽만 0 이면 개선된 것처럼 보인다 —
     * 이 컬럼이 생기기 전 실행이 그렇다.
     */
    const keys = metricsOf(run({ travel: null }), run()).map((m) => m.key);
    expect(keys).not.toContain('travelMinutes');
    expect(keys).not.toContain('travelMeters');

    const both = metricsOf(run(), run({ travel: null })).map((m) => m.key);
    expect(both).not.toContain('travelMinutes');
  });

  it('둘 다 있으면 분 단위로 반올림해 준다', () => {
    const m = metricsOf(
      run({ travel: { durationSeconds: 11_400, distanceMeters: 86_000 } }),
      run({ travel: { durationSeconds: 8_700, distanceMeters: 63_000 } }),
    );
    expect(m.find((x) => x.key === 'travelMinutes')).toMatchObject({ before: 190, after: 145 });
    expect(m.find((x) => x.key === 'travelMeters')).toMatchObject({ before: 86_000, after: 63_000 });
  });

  it('합이 0 인 것과 산출하지 않은 것은 다르다', () => {
    // 대중교통 상품이거나 전 구간 조회 실패면 0 이다. 그건 산출한 값이라 지표를 낸다
    const m = metricsOf(run({ travel: { durationSeconds: 0, distanceMeters: 0 } }), run());
    expect(m.find((x) => x.key === 'travelMinutes')).toMatchObject({ before: 0 });
  });
});

describe('경고 배너 (FR-PA-027 · EX-PA-005)', () => {
  it('🔴 준비도가 떨어져도 되돌리기 수단은 열려 있다 — 자동 롤백하지 않는다', () => {
    const body = toComparisonResponse(application, run({ score: 90 }), run({ score: 60 }));
    expect(body.warningBanner).toContain('출시 준비도가 낮아졌습니다');
    // 경고와 되돌리기 가능 여부는 별개다. 시스템이 사용자의 수정을 무르지 않는다
    expect(body.revertible).toBe(true);
  });

  it('🔴 차단이 늘면 그쪽을 먼저 말한다', () => {
    const body = toComparisonResponse(
      application, run({ score: 90, counts: { BLOCKER: 0 } }), run({ score: 95, counts: { BLOCKER: 1 } }),
    );
    // 점수가 올랐어도 차단이 늘었으면 경고다
    expect(body.warningBanner).toContain('차단 항목이 늘었습니다');
  });

  it('나아졌으면 경고가 없다', () => {
    expect(toComparisonResponse(application, run({ score: 29 }), run({ score: 93 })).warningBanner).toBeNull();
  });

  it('🔴 되돌린 이력이면 되돌리기 수단이 닫힌다', () => {
    const reverted = { ...application, revertedAt: new Date('2026-09-15T06:02:44Z') };
    expect(toComparisonResponse(reverted, run(), run()).revertible).toBe(false);
  });
});

describe('총 감점 (FR-PA-041)', () => {
  it('부분 검수는 점수가 없어 감점도 없다 (FR-AU-029)', () => {
    const m = metricsOf(run({ score: null }), run({ score: 90 }));
    expect(m.find((x) => x.key === 'deduction')).toMatchObject({ before: null, after: 10 });
  });
});
