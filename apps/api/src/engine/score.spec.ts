import { describe, expect, it } from 'vitest';
import type { ReasonCode, Severity } from '@tourlint/shared';
import { calculateReadiness, type ScorableFinding } from './score';

const f = (severity: Severity, over: Partial<ScorableFinding> = {}): ScorableFinding => ({
  severity, reasonCode: 'REST_DAY_CONFLICT', dismissed: false, needsConfirmation: false, ...over,
});

const many = (severity: Severity, n: number, over?: Partial<ScorableFinding>): ScorableFinding[] =>
  Array.from({ length: n }, () => f(severity, over));

describe('출시 준비도 — 기대값 표 4종을 재현한다', () => {
  it('TP-01 표준 → 96점 · 차단 0 · 주의 1', () => {
    const r = calculateReadiness({ findings: many('WARNING', 1), targetCount: 12 });
    expect(r.score).toBe(96);
    expect(r.releaseBlocked).toBe(false);
    expect(r.breakdown).toBe('100 − (0×25) − (0×10) − (1×4) − (0×3) = 96점');
  });

  it('TP-02 경계 → 67점 · 차단 1 · 주의 2', () => {
    const r = calculateReadiness({ findings: [...many('BLOCKER', 1), ...many('WARNING', 2)], targetCount: 9 });
    expect(r.score).toBe(67);
    expect(r.releaseBlocked).toBe(true);
  });

  it('TP-03 위반 → 29점 · 명세 FR-AU-041 AC 와 정확히 일치', () => {
    const r = calculateReadiness({
      findings: [...many('BLOCKER', 2), ...many('ERROR', 1), ...many('WARNING', 2), ...many('UNVERIFIED', 1)],
      targetCount: 8,
    });
    expect(r.score).toBe(29);
    expect(r.breakdown).toBe('100 − (2×25) − (1×10) − (2×4) − (1×3) = 29점');
    expect(r.releaseBlocked).toBe(true);
  });

  it('TP-04a 4/8 실패(50%, 초과 아님) → 88점을 **산출한다**', () => {
    const r = calculateReadiness({ findings: many('UNVERIFIED', 4), targetCount: 8, failedCount: 4 });
    expect(r.isPartial).toBe(false);
    expect(r.score).toBe(88);
  });

  it('TP-04b 5/8 실패(62.5%, 초과) → 점수를 내지 않는다', () => {
    const r = calculateReadiness({ findings: many('UNVERIFIED', 5), targetCount: 8, failedCount: 5 });
    expect(r.isPartial).toBe(true);
    expect(r.score).toBeNull();
    expect(r.breakdown).toContain('점수 미산출');
  });
});

describe('부분 검수 경계는 **초과**다 (FR-AU-029)', () => {
  it.each([[4, false], [5, true]])('8곳 중 %i곳 실패 → isPartial=%s', (failed, expected) => {
    expect(calculateReadiness({ findings: [], targetCount: 8, failedCount: failed }).isPartial).toBe(expected);
  });

  it('대상이 0이면 부분 검수가 아니다 — 0으로 나누지 않는다', () => {
    expect(calculateReadiness({ findings: [], targetCount: 0, failedCount: 0 }).isPartial).toBe(false);
  });
});

describe('하한과 상한', () => {
  it('하한은 0점이다 — 음수로 내려가지 않는다', () => {
    expect(calculateReadiness({ findings: many('BLOCKER', 10), targetCount: 12 }).score).toBe(0);
  });

  it('finding 이 없으면 100점이다', () => {
    expect(calculateReadiness({ findings: [], targetCount: 8 }).score).toBe(100);
  });

  it('상품 규모로 정규화하지 않는다 (FR-AU-049)', () => {
    // 12곳짜리와 4곳짜리에서 같은 문제 1건은 같은 감점이다
    const a = calculateReadiness({ findings: many('ERROR', 1), targetCount: 12 });
    const b = calculateReadiness({ findings: many('ERROR', 1), targetCount: 4 });
    expect(a.score).toBe(b.score);
  });
});

describe('무시 처리 (FR-AU-046 · 047)', () => {
  it('무시한 finding 은 감점에서 빠지되 건수로 남는다', () => {
    const r = calculateReadiness({
      findings: [f('ERROR'), f('ERROR', { dismissed: true })],
      targetCount: 8,
    });
    expect(r.score).toBe(90);
    expect(r.counts.ERROR).toBe(2);
    expect(r.scoredCounts.ERROR).toBe(1);
    expect(r.dismissedCount).toBe(1);
  });

  it('차단은 무시할 수 없다 — 무시 표시가 붙어 있어도 감점한다', () => {
    const r = calculateReadiness({ findings: [f('BLOCKER', { dismissed: true })], targetCount: 8 });
    expect(r.score).toBe(75);
    expect(r.dismissedCount).toBe(0);
    // DB 제약이 막고 있어야 할 상태다. 조용히 넘기지 않고 드러낸다
    expect(r.invalidDismissals).toBe(1);
    expect(r.releaseBlocked).toBe(true);
  });
});

describe('감점하지 않는 사유 (FR-AU-045)', () => {
  it('출발 전 최종 확인 항목은 감점 대상이 아니다', () => {
    const r = calculateReadiness({
      findings: [f('WARNING', { reasonCode: 'PRE_DEPARTURE_CHECK' as ReasonCode, needsConfirmation: true })],
      targetCount: 8,
    });
    expect(r.score).toBe(100);
    expect(r.counts.WARNING).toBe(1);
    expect(r.scoredCounts.WARNING).toBe(0);
    // 감점은 안 해도 확인 필요 목록에는 오른다
    expect(r.needsConfirmationCount).toBe(1);
  });
});

describe('확인 필요 N건은 확인 불가 건수와 다르다 (FR-AU-044)', () => {
  it('추정으로 강등된 주의도 확인 필요에 든다', () => {
    const r = calculateReadiness({
      findings: [
        f('WARNING', { needsConfirmation: true }),   // 추정 강등
        f('UNVERIFIED', { needsConfirmation: true }),
        f('ERROR'),
      ],
      targetCount: 8,
    });
    expect(r.counts.UNVERIFIED).toBe(1);
    expect(r.needsConfirmationCount).toBe(2);
    expect(r.score).toBe(100 - 4 - 3 - 10);
  });
});

describe('가중치는 산출 시점 값을 쓴다 (DR-CF-006)', () => {
  it('주입한 가중치로 계산한다', () => {
    const r = calculateReadiness({
      findings: many('WARNING', 2),
      weights: { BLOCKER: 30, ERROR: 12, WARNING: 5, UNVERIFIED: 2 },
      targetCount: 8,
    });
    expect(r.score).toBe(90);
    expect(r.breakdown).toContain('(2×5)');
  });
});

describe('계산식 노출 (FR-AU-043)', () => {
  it('건수가 0인 등급도 식에 남긴다', () => {
    // 식이 빠지면 사용자가 "왜 이 점수인가" 를 되짚을 수 없다
    expect(calculateReadiness({ findings: [], targetCount: 8 }).breakdown)
      .toBe('100 − (0×25) − (0×10) − (0×4) − (0×3) = 100점');
  });
});

describe('결정론성 (NF-MT-001)', () => {
  it('같은 입력이면 같은 결과다', () => {
    const input = { findings: [...many('BLOCKER', 2), ...many('WARNING', 1)], targetCount: 8, failedCount: 1 };
    const runs = Array.from({ length: 5 }, () => calculateReadiness(input));
    for (const r of runs) expect(r).toEqual(runs[0]);
  });
});
