import {
  BUDGET_THRESHOLD_RATIO,
  extraServiceDailyCap,
  KTO_PROVIDER_OF,
  type KtoService,
} from '@tourlint/shared';
import { localDateKey, type CallProvider, type DailyCallCounter } from './api-call-log';

/**
 * 일일 호출 예산 관리자 (FR-OP-002 ~ 006).
 *
 * 경계가 둘이고 **의도에 따라 다르다** — 이게 이 파일의 전부다.
 *   자동 배치                      80% 도달 시 중지   (FR-OP-003)
 *   사용자가 누른 검수 · 기획 조회 · 에이전트  100% 도달 시 차단  (FR-OP-003 · 004 · EI-CM-012)
 *
 * 예산은 계정별이 아니라 **서비스 전체(단일 인증키)** 기준이다 (PM-DA-006). 공사 서비스는
 * 서비스마다 따로 센다 — `ktoBudgetGuard` (API 8-2).
 */

/** 호출을 일으킨 의도. 경계값이 갈리는 유일한 축이다 */
export type CallIntent =
  /** 자동 배치 — 미룰 수 있으므로 먼저 멈춘다 */
  | 'BATCH'
  /** 사용자가 명시적으로 누른 검수·재검수 */
  | 'USER_AUDIT'
  /**
   * 기획 조회(장소 찾기 · 장소 정보 한 줄 · 장소 담기)와 에이전트의 공사 호출.
   * 경계는 `USER_AUDIT` 과 같은 100% 다 — 사용자가 화면에서 누른 것이라 미룰 수 없다 (D2 · API 8-2)
   */
  | 'PLAN';

export interface BudgetSnapshot {
  readonly dailyBudget: number;
  readonly usedToday: number;
}

export interface BudgetDecision {
  readonly allowed: boolean;
  /** 0 ~ 1+. 예산이 0 이하면 1 로 본다 (전면 중지 의도) */
  readonly ratio: number;
  readonly reasonCode: 'BUDGET_THRESHOLD' | 'BUDGET_EXHAUSTED' | null;
  /** 80% 이상 — 위젯 경고색 · 상단 배너 (FR-OP-006) */
  readonly warn: boolean;
  readonly remaining: number;
}

/**
 * 순수 함수. 시계도 DB 도 보지 않으므로 경계값을 그대로 시험할 수 있다.
 *
 * 경계는 양쪽 다 **도달 시점 포함**이다 — "80%에 도달하면 중지" · "100% 도달 시 차단".
 */
export function evaluateBudget(snapshot: BudgetSnapshot, intent: CallIntent): BudgetDecision {
  const { dailyBudget, usedToday } = snapshot;
  const ratio = dailyBudget > 0 ? usedToday / dailyBudget : 1;
  const warn = ratio >= BUDGET_THRESHOLD_RATIO.WARN;
  const remaining = Math.max(0, dailyBudget - usedToday);

  if (ratio >= BUDGET_THRESHOLD_RATIO.EXHAUSTED) {
    return { allowed: false, ratio, reasonCode: 'BUDGET_EXHAUSTED', warn, remaining };
  }
  if (intent === 'BATCH' && warn) {
    return { allowed: false, ratio, reasonCode: 'BUDGET_THRESHOLD', warn, remaining };
  }
  return { allowed: true, ratio, reasonCode: null, warn, remaining };
}

export interface BudgetGuardOptions {
  readonly counter: DailyCallCounter;
  /**
   * 그 날의 예산. **기본값을 두지 않는다** — 코드 상수(8,000)로 떨어지면 DB 값도 증설 종료도 안
   * 먹는다. 검수 예산 문이 그렇게 DB 를 안 읽고 있었다 (#777). 국문은 `BatchStateRepository.setting()`
   * 의 `dailyQuota`, 새 서비스는 `extraServiceDailyCap()` 이다.
   */
  readonly dailyBudget: number;
  readonly provider?: CallProvider;
  /** 테스트 주입용 */
  readonly clock?: () => Date;
}

/**
 * 공사가 오늘 한도 초과라고 답했으면 우리 집계와 상관없이 다 쓴 것이다 (EX-QT-005 · EX-EI-003 · #793).
 *
 * 예산은 한도의 80% 로 잡지만 공사 쪽 집계가 앞설 수 있다(판단 근거 원문 펼침처럼 예산 문이 없는
 * 호출도 센다). 그때는 공사 응답이 우선이라 그날은 새 요청을 막고, 한국 시간 자정에 풀린다.
 */
export function reconcileUsage(usedToday: number, dailyBudget: number, quotaRejected: boolean): number {
  return quotaRejected ? Math.max(usedToday, dailyBudget) : usedToday;
}

export class BudgetGuard {
  private readonly counter: DailyCallCounter;
  private readonly dailyBudget: number;
  private readonly provider: CallProvider;
  private readonly clock: () => Date;

  constructor(options: BudgetGuardOptions) {
    this.counter = options.counter;
    this.dailyBudget = options.dailyBudget;
    this.provider = options.provider ?? 'KTO';
    this.clock = options.clock ?? (() => new Date());
  }

  async snapshot(): Promise<BudgetSnapshot> {
    const now = this.clock();
    const [usedToday, rejected] = await Promise.all([
      this.counter.countToday(this.provider, now),
      this.counter.quotaRejectedToday(this.provider, now),
    ]);
    return { dailyBudget: this.dailyBudget, usedToday: reconcileUsage(usedToday, this.dailyBudget, rejected) };
  }

  async check(intent: CallIntent): Promise<BudgetDecision> {
    return evaluateBudget(await this.snapshot(), intent);
  }

  /** 차단이면 던진다. 호출 직전에 한 줄로 쓰기 위한 편의 */
  async assertAllowed(intent: CallIntent): Promise<BudgetDecision> {
    const decision = await this.check(intent);
    if (!decision.allowed) throw new BudgetBlockedError(decision);
    return decision;
  }
}

/**
 * 공사 서비스 하나의 예산 게이트 (외부 연동 3-1 · API 8-2).
 *
 * 국문 관광정보(`KOR`)는 `system_setting.daily_quota`, 새 서비스 5종은 각각
 * `extraServiceDailyCap()` 이다 — 서비스마다 한도가 다르고(증설 대상이 3종뿐이다)
 * 증설이 기간제라 날짜를 본다. 소진량도 그 서비스의 제공자만 센다 — 한 값으로 세면
 * 새 서비스 호출이 국문 예산을 잠식하고 자기 한도는 세지 못한다.
 * 게이트는 부르려는 서비스의 것을 쓴다(`KTO_SERVICE_OF[operation]`).
 */
export function ktoBudgetGuard(
  service: KtoService,
  options: { readonly counter: DailyCallCounter; readonly dailyQuota: number; readonly clock?: () => Date },
): BudgetGuard {
  const now = (options.clock ?? (() => new Date()))();
  return new BudgetGuard({
    counter: options.counter,
    provider: KTO_PROVIDER_OF[service],
    dailyBudget: service === 'KOR'
      ? options.dailyQuota
      : extraServiceDailyCap(service, localDateKey(now)),
    clock: options.clock,
  });
}

export class BudgetBlockedError extends Error {
  readonly reasonCode: 'BUDGET_THRESHOLD' | 'BUDGET_EXHAUSTED';
  constructor(readonly decision: BudgetDecision) {
    super(
      decision.reasonCode === 'BUDGET_EXHAUSTED'
        ? `일일 호출 예산을 모두 사용했다 (${Math.round(decision.ratio * 100)}%)`
        : `일일 호출 예산 ${Math.round(BUDGET_THRESHOLD_RATIO.WARN * 100)}% 도달로 자동 배치를 중지했다`,
    );
    this.name = 'BudgetBlockedError';
    // reasonCode 가 null 인 결정으로는 만들지 않는다
    this.reasonCode = decision.reasonCode ?? 'BUDGET_EXHAUSTED';
  }
}
