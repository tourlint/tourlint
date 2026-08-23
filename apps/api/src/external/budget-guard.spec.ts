import { describe, expect, it } from 'vitest';
import { SYSTEM_SETTING_DEFAULTS } from '@tourlint/shared';
import { InMemoryApiCallLogger, localDateKey, type ApiCallLogEntry } from './api-call-log';
import { BudgetBlockedError, BudgetGuard, evaluateBudget } from './budget-guard';

describe('evaluateBudget — 경계가 둘이고 의도에 따라 다르다 (FR-OP-003 · 004)', () => {
  const at = (usedToday: number, dailyBudget = 800): { dailyBudget: number; usedToday: number } => ({ dailyBudget, usedToday });

  describe('자동 배치 — 80% 도달 시 중지', () => {
    it('79.9% 까지는 돈다', () => {
      expect(evaluateBudget(at(639), 'BATCH').allowed).toBe(true);
    });

    it('정확히 80% 에서 멈춘다 — "도달하면" 이므로 경계 포함이다', () => {
      const d = evaluateBudget(at(640), 'BATCH');
      expect(d.allowed).toBe(false);
      expect(d.reasonCode).toBe('BUDGET_THRESHOLD');
    });

    it('100% 를 넘으면 사유가 BUDGET_EXHAUSTED 로 바뀐다', () => {
      expect(evaluateBudget(at(800), 'BATCH').reasonCode).toBe('BUDGET_EXHAUSTED');
    });
  });

  describe('사용자 "지금 재검수" — 100% 도달 시 차단', () => {
    it('80% 를 넘어도 사용자 검수는 계속 허용한다', () => {
      // 배치는 미룰 수 있지만 사용자가 누른 검수는 미룰 수 없다
      const d = evaluateBudget(at(700), 'USER_AUDIT');
      expect(d.allowed).toBe(true);
      expect(d.warn).toBe(true);
    });

    it('99.9% 까지 허용한다', () => {
      expect(evaluateBudget(at(799), 'USER_AUDIT').allowed).toBe(true);
    });

    it('정확히 100% 에서 차단한다', () => {
      const d = evaluateBudget(at(800), 'USER_AUDIT');
      expect(d.allowed).toBe(false);
      expect(d.reasonCode).toBe('BUDGET_EXHAUSTED');
    });

    it('초과해도 차단이다', () => {
      expect(evaluateBudget(at(1200), 'USER_AUDIT').allowed).toBe(false);
    });
  });

  describe('경고 표시 — 배치 중지 경계와 같은 값이다 (FR-OP-006)', () => {
    it.each([
      [639, false],
      [640, true],
      [800, true],
    ])('%i건이면 warn=%s', (used, warn) => {
      expect(evaluateBudget(at(used), 'USER_AUDIT').warn).toBe(warn);
      expect(evaluateBudget(at(used), 'BATCH').warn).toBe(warn);
    });
  });

  it('남은 건수는 음수로 내려가지 않는다', () => {
    expect(evaluateBudget(at(1200), 'USER_AUDIT').remaining).toBe(0);
    expect(evaluateBudget(at(300), 'USER_AUDIT').remaining).toBe(500);
  });

  it('예산 0 은 전면 중지로 읽는다 — 0으로 나눠 NaN 을 만들지 않는다', () => {
    const d = evaluateBudget(at(0, 0), 'USER_AUDIT');
    expect(d.ratio).toBe(1);
    expect(d.allowed).toBe(false);
  });

  it('같은 입력이면 같은 판정이다 — 시계도 DB 도 보지 않는다', () => {
    expect(evaluateBudget(at(640), 'BATCH')).toEqual(evaluateBudget(at(640), 'BATCH'));
  });
});

describe('BudgetGuard', () => {
  const clockAt = (iso: string) => (): Date => new Date(iso);

  const entry = (calledAt: string, over: Partial<ApiCallLogEntry> = {}): ApiCallLogEntry => ({
    provider: 'KTO', operation: 'searchKeyword2', calledAt: new Date(calledAt),
    status: 'OK', httpStatus: 200, resultCode: '0000', latencyMs: 30, auditRunId: null, ...over,
  });

  it('기본 예산은 800건이다 — 개발계정 한도의 80% (FR-OP-002)', async () => {
    const guard = new BudgetGuard({ counter: new InMemoryApiCallLogger(), clock: clockAt('2026-08-22T04:00:00Z') });
    expect((await guard.snapshot()).dailyBudget).toBe(SYSTEM_SETTING_DEFAULTS.dailyQuota);
    expect(SYSTEM_SETTING_DEFAULTS.dailyQuota).toBe(800);
  });

  it('소진량은 계정별이 아니라 서비스 전체 기준이다 (PM-DA-006)', async () => {
    const logger = new InMemoryApiCallLogger();
    // 서로 다른 검수 실행의 호출이 하나의 소진량으로 합산된다
    logger.record(entry('2026-08-22T04:00:00Z', { auditRunId: 1 }));
    logger.record(entry('2026-08-22T04:00:01Z', { auditRunId: 2 }));
    const guard = new BudgetGuard({ counter: logger, clock: clockAt('2026-08-22T05:00:00Z') });
    expect((await guard.snapshot()).usedToday).toBe(2);
  });

  it('공사 외 제공자 호출은 예산에 합산하지 않는다', async () => {
    const logger = new InMemoryApiCallLogger();
    logger.record(entry('2026-08-22T04:00:00Z'));
    logger.record(entry('2026-08-22T04:00:01Z', { provider: 'KAKAO_MOBILITY', operation: 'future/directions' }));
    const guard = new BudgetGuard({ counter: logger, clock: clockAt('2026-08-22T05:00:00Z') });
    expect((await guard.snapshot()).usedToday).toBe(1);
  });

  it('실패 호출도 소진량에 든다 — 실제로 나간 호출이다', async () => {
    const logger = new InMemoryApiCallLogger();
    logger.record(entry('2026-08-22T04:00:00Z', { status: 'FAIL', resultCode: null }));
    const guard = new BudgetGuard({ counter: logger, clock: clockAt('2026-08-22T05:00:00Z') });
    expect((await guard.snapshot()).usedToday).toBe(1);
  });

  it('차단이면 사유코드를 단 예외를 던진다', async () => {
    const logger = new InMemoryApiCallLogger();
    for (let i = 0; i < 640; i++) logger.record(entry('2026-08-22T04:00:00Z'));
    const guard = new BudgetGuard({ counter: logger, clock: clockAt('2026-08-22T05:00:00Z') });

    await expect(guard.assertAllowed('USER_AUDIT')).resolves.toMatchObject({ allowed: true, warn: true });
    const e = await guard.assertAllowed('BATCH').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BudgetBlockedError);
    expect((e as BudgetBlockedError).reasonCode).toBe('BUDGET_THRESHOLD');
  });
});

describe('하루 경계는 한국 시간 기준이다', () => {
  it('KST 자정에 초기화된다 — UTC 로 세면 오후 9시 이후 호출이 다음 날로 넘어간다', () => {
    // 2026-08-22 08:00 KST = 2026-08-21 23:00 UTC
    expect(localDateKey(new Date('2026-08-21T23:00:00Z'))).toBe('2026-08-22');
    // 2026-08-22 23:59 KST
    expect(localDateKey(new Date('2026-08-22T14:59:00Z'))).toBe('2026-08-22');
    // 2026-08-23 00:00 KST — 여기서 넘어간다
    expect(localDateKey(new Date('2026-08-22T15:00:00Z'))).toBe('2026-08-23');
  });

  it('전날 호출은 오늘 소진량에 들지 않는다', () => {
    const logger = new InMemoryApiCallLogger();
    const e = (iso: string): ApiCallLogEntry => ({
      provider: 'KTO', operation: 'searchKeyword2', calledAt: new Date(iso),
      status: 'OK', httpStatus: 200, resultCode: '0000', latencyMs: 1, auditRunId: null,
    });
    logger.record(e('2026-08-21T14:00:00Z')); // 8/21 23:00 KST
    logger.record(e('2026-08-21T15:00:00Z')); // 8/22 00:00 KST
    expect(logger.countToday('KTO', new Date('2026-08-22T05:00:00Z'))).toBe(1);
  });
});

describe('InMemoryApiCallLogger — 위젯 표시용 집계 (FR-OP-005)', () => {
  it('오퍼레이션별 상위 5개를 낸다', () => {
    const logger = new InMemoryApiCallLogger();
    const push = (operation: string, n: number): void => {
      for (let i = 0; i < n; i++) {
        logger.record({ provider: 'KTO', operation, calledAt: new Date('2026-08-22T04:00:00Z'), status: 'OK', httpStatus: 200, resultCode: '0000', latencyMs: 1, auditRunId: null });
      }
    };
    push('detailIntro2', 30); push('detailCommon2', 20); push('searchKeyword2', 12);
    push('locationBasedList2', 5); push('searchFestival2', 3); push('ldongCode2', 1);

    const top = logger.topOperations('KTO', new Date('2026-08-22T05:00:00Z'));
    expect(top).toHaveLength(5);
    expect(top[0]).toEqual({ operation: 'detailIntro2', count: 30 });
    expect(top.map((t) => t.operation)).not.toContain('ldongCode2');
  });
});
