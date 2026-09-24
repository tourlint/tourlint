import { describe, expect, it } from 'vitest';
import {
  BUDGET_THRESHOLD_RATIO, EXTRA_SERVICE_BASE_CAP, EXTRA_SERVICE_QUOTA_RAISED,
  KOR_BASE_DAILY_QUOTA, KOR_QUOTA_RAISED_UNTIL, SYSTEM_SETTING_DEFAULTS, korDailyQuota, type CallProvider,
} from '@tourlint/shared';
import { InMemoryApiCallLogger, localDateKey, type ApiCallLogEntry } from './api-call-log';
import { BudgetBlockedError, BudgetGuard, evaluateBudget, ktoBudgetGuard } from './budget-guard';

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

  describe('기획 조회 · 에이전트(PLAN) — 경계는 사용자 검수와 같은 100% (EI-CM-012 · D2)', () => {
    it('🔴 80% 를 넘어도 막지 않는다 — 80% 에서 멈추는 것은 자동 배치뿐이다', () => {
      const d = evaluateBudget(at(640), 'PLAN');
      expect(d.allowed).toBe(true);
      expect(d.warn).toBe(true);
    });

    it('🔴 99.9% 까지 허용한다', () => {
      expect(evaluateBudget(at(799), 'PLAN').allowed).toBe(true);
    });

    it('🔴 정확히 100% 에서 BUDGET_EXHAUSTED 로 막는다', () => {
      expect(evaluateBudget(at(800), 'PLAN')).toMatchObject({ allowed: false, reasonCode: 'BUDGET_EXHAUSTED' });
    });

    it('어느 소진율에서도 사용자 검수와 같은 판정이다', () => {
      for (const used of [0, 639, 640, 799, 800, 1200]) {
        expect(evaluateBudget(at(used), 'PLAN')).toEqual(evaluateBudget(at(used), 'USER_AUDIT'));
      }
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

  it('예산은 받은 값이다 — 코드 기본값으로 떨어지지 않는다 (#777)', async () => {
    // 기본값이 있던 때 검수 예산 문이 DB 를 안 읽고 8,000 을 썼다. 이제 안 넘기면 타입 검사가 막는다
    const guard = new BudgetGuard({ counter: new InMemoryApiCallLogger(), dailyBudget: 1234, clock: clockAt('2026-08-22T04:00:00Z') });
    expect((await guard.snapshot()).dailyBudget).toBe(1234);
    expect(SYSTEM_SETTING_DEFAULTS.dailyQuota).toBe(8000);
  });

  it('소진량은 계정별이 아니라 서비스 전체 기준이다 (PM-DA-006)', async () => {
    const logger = new InMemoryApiCallLogger();
    // 서로 다른 검수 실행의 호출이 하나의 소진량으로 합산된다
    logger.record(entry('2026-08-22T04:00:00Z', { auditRunId: 1 }));
    logger.record(entry('2026-08-22T04:00:01Z', { auditRunId: 2 }));
    const guard = new BudgetGuard({ counter: logger, dailyBudget: SYSTEM_SETTING_DEFAULTS.dailyQuota, clock: clockAt('2026-08-22T05:00:00Z') });
    expect((await guard.snapshot()).usedToday).toBe(2);
  });

  it('공사 외 제공자 호출은 예산에 합산하지 않는다', async () => {
    const logger = new InMemoryApiCallLogger();
    logger.record(entry('2026-08-22T04:00:00Z'));
    logger.record(entry('2026-08-22T04:00:01Z', { provider: 'KAKAO_MOBILITY', operation: 'future/directions' }));
    const guard = new BudgetGuard({ counter: logger, dailyBudget: SYSTEM_SETTING_DEFAULTS.dailyQuota, clock: clockAt('2026-08-22T05:00:00Z') });
    expect((await guard.snapshot()).usedToday).toBe(1);
  });

  it('실패 호출도 소진량에 든다 — 실제로 나간 호출이다', async () => {
    const logger = new InMemoryApiCallLogger();
    logger.record(entry('2026-08-22T04:00:00Z', { status: 'FAIL', resultCode: null }));
    const guard = new BudgetGuard({ counter: logger, dailyBudget: SYSTEM_SETTING_DEFAULTS.dailyQuota, clock: clockAt('2026-08-22T05:00:00Z') });
    expect((await guard.snapshot()).usedToday).toBe(1);
  });

  it('차단이면 사유코드를 단 예외를 던진다', async () => {
    const logger = new InMemoryApiCallLogger();
    // 기본 예산의 경고선(80%)을 **계산해서** 쌓는다. 건수를 박으면 기본값이 바뀔 때 조용히 빗나간다
    const warnAt = SYSTEM_SETTING_DEFAULTS.dailyQuota * BUDGET_THRESHOLD_RATIO.WARN;
    for (let i = 0; i < warnAt; i++) logger.record(entry('2026-08-22T04:00:00Z'));
    const guard = new BudgetGuard({ counter: logger, dailyBudget: SYSTEM_SETTING_DEFAULTS.dailyQuota, clock: clockAt('2026-08-22T05:00:00Z') });

    await expect(guard.assertAllowed('USER_AUDIT')).resolves.toMatchObject({ allowed: true, warn: true });
    const e = await guard.assertAllowed('BATCH').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BudgetBlockedError);
    expect((e as BudgetBlockedError).reasonCode).toBe('BUDGET_THRESHOLD');
  });
});

describe('ktoBudgetGuard — 공사 서비스마다 따로 센다 (외부 연동 3-1 · API 8-2)', () => {
  const clock = (): Date => new Date('2026-08-22T05:00:00Z');
  const fill = (logger: InMemoryApiCallLogger, provider: CallProvider, n: number): void => {
    for (let i = 0; i < n; i++) {
      logger.record({
        provider, operation: 'op', calledAt: new Date('2026-08-22T04:00:00Z'),
        status: 'OK', httpStatus: 200, resultCode: '0000', latencyMs: 1, auditRunId: null,
      });
    }
  };

  it('🔴 무장애 800건 소진이 국문 예산에 섞이지 않는다', async () => {
    const logger = new InMemoryApiCallLogger();
    fill(logger, 'KTO_WITH', 800);
    const withGuard = ktoBudgetGuard('WITH', { counter: logger, dailyQuota: 800, clock });
    const korGuard = ktoBudgetGuard('KOR', { counter: logger, dailyQuota: 800, clock });

    await expect(withGuard.check('PLAN')).resolves.toMatchObject({ allowed: false, reasonCode: 'BUDGET_EXHAUSTED' });
    await expect(korGuard.check('PLAN')).resolves.toMatchObject({ allowed: true, ratio: 0 });
  });

  it('🔴 국문 소진도 새 서비스 예산에 섞이지 않고, 새 서비스끼리도 따로다', async () => {
    const logger = new InMemoryApiCallLogger();
    fill(logger, 'KTO', 800);
    fill(logger, 'KTO_PET', 800);
    await expect(ktoBudgetGuard('RELATED', { counter: logger, dailyQuota: 800, clock }).snapshot())
      .resolves.toEqual({ dailyBudget: EXTRA_SERVICE_BASE_CAP, usedToday: 0 });
    await expect(ktoBudgetGuard('PET', { counter: logger, dailyQuota: 800, clock }).snapshot())
      .resolves.toEqual({ dailyBudget: EXTRA_SERVICE_BASE_CAP, usedToday: 800 });
  });

  // 이 블록의 시계는 2026-08-22 — 증설 전이다. 증설 기간의 값은 아래 describe 에서 본다
  it('🔴 국문은 daily_quota 를, 새 서비스 5종은 각 800건을 분모로 쓴다 (증설 전)', async () => {
    const counter = new InMemoryApiCallLogger();
    expect((await ktoBudgetGuard('KOR', { counter, dailyQuota: 1200, clock }).snapshot()).dailyBudget).toBe(1200);
    for (const service of ['PET', 'WITH', 'RELATED', 'DURUNUBI', 'VISITOR'] as const) {
      expect((await ktoBudgetGuard(service, { counter, dailyQuota: 1200, clock }).snapshot()).dailyBudget).toBe(800);
    }
  });

  /*
   * 증설은 기간제다 (#508). 3종만 늘었고, 기간 밖이면 다섯 다 800 으로 돌아간다 —
   * 위 검사들의 시계(2026-08-22)가 증설 전이라 그쪽은 800 이 맞는 답이다.
   */
  describe('트래픽 증설 기간 — 늘어난 것은 5종 중 3종뿐이다 (#508)', () => {
    const RAISED = ['WITH', 'PET', 'RELATED'] as const;
    const KEPT = ['DURUNUBI', 'VISITOR'] as const;
    const budgetOn = async (iso: string, service: Parameters<typeof ktoBudgetGuard>[0]): Promise<number> =>
      (await ktoBudgetGuard(service, {
        counter: new InMemoryApiCallLogger(), dailyQuota: 1200, clock: () => new Date(iso),
      }).snapshot()).dailyBudget;

    it('🔴 기간 안에는 무장애 · 반려동물 · 연관 관광지만 8,000 이다', async () => {
      for (const service of RAISED) expect(await budgetOn('2026-09-20T05:00:00Z', service)).toBe(8000);
      for (const service of KEPT) expect(await budgetOn('2026-09-20T05:00:00Z', service)).toBe(EXTRA_SERVICE_BASE_CAP);
    });

    it('🔴 기간이 끝나면 셋 다 800 으로 돌아간다 — 공사가 거절할 호출을 통과시키지 않는다', async () => {
      // 2026-10-17 00:00 KST = 2026-10-16 15:00 UTC. 만료 다음 날이다
      for (const service of RAISED) expect(await budgetOn('2026-10-16T15:00:00Z', service)).toBe(EXTRA_SERVICE_BASE_CAP);
    });

    it('마지막 날까지는 늘어난 값이다 — 경계는 포함이다', async () => {
      // 2026-10-16 23:00 KST = 2026-10-16 14:00 UTC
      expect(await budgetOn('2026-10-16T14:00:00Z', 'WITH')).toBe(8000);
      expect(EXTRA_SERVICE_QUOTA_RAISED.until).toBe('2026-10-16');
    });
  });

  it('자동 배치는 새 서비스도 80% 에서 멈춘다 — 레이더 T3 방문자수 배치', async () => {
    const logger = new InMemoryApiCallLogger();
    fill(logger, 'KTO_VISITOR', 640);
    const guard = ktoBudgetGuard('VISITOR', { counter: logger, dailyQuota: 800, clock });
    await expect(guard.check('BATCH')).resolves.toMatchObject({ allowed: false, reasonCode: 'BUDGET_THRESHOLD' });
    await expect(guard.check('PLAN')).resolves.toMatchObject({ allowed: true });
  });
});

/*
 * 국문 증설은 2026-10-11 까지다 (공공데이터포털 활용신청 화면 · 2026-09-25 확인). 새 서비스 3종
 * (10-16)보다 빠르고 배포 금지 기간(10.01 – 11.05) 안이라 코드가 날짜를 안다 (#777).
 */
describe('국문 증설 종료 — korDailyQuota (#777)', () => {
  it('🔴 끝난 다음 날부터 국문 예산은 800 을 넘지 않는다', () => {
    expect(korDailyQuota(8000, '2026-10-12')).toBe(KOR_BASE_DAILY_QUOTA);
    expect(KOR_BASE_DAILY_QUOTA).toBe(800);
  });

  it('마지막 날까지는 DB 값 그대로다 — 경계는 포함이다', () => {
    expect(korDailyQuota(8000, '2026-10-11')).toBe(8000);
    expect(KOR_QUOTA_RAISED_UNTIL).toBe('2026-10-11');
  });

  it('운영자가 더 낮게 둔 값은 그대로 따른다', () => {
    expect(korDailyQuota(500, '2026-10-12')).toBe(500);
  });

  it('증설 전 날짜는 건드리지 않는다 — 그때는 DB 값이 800 이었다', () => {
    expect(korDailyQuota(1200, '2026-08-22')).toBe(1200);
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
