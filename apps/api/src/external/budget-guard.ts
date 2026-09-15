import {
  BUDGET_THRESHOLD_RATIO,
  EXTRA_PROVIDER_DAILY_CAP,
  KTO_PROVIDER_OF,
  SYSTEM_SETTING_DEFAULTS,
  type KtoService,
} from '@tourlint/shared';
import type { CallProvider, DailyCallCounter } from './api-call-log';

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
  /** 전역 1행 `system_setting.daily_call_budget`. 기본 800건 = 개발계정 한도의 80% */
  readonly dailyBudget?: number;
  readonly provider?: CallProvider;
  /** 테스트 주입용 */
  readonly clock?: () => Date;
}

export class BudgetGuard {
  private readonly counter: DailyCallCounter;
  private readonly dailyBudget: number;
  private readonly provider: CallProvider;
  private readonly clock: () => Date;

  constructor(options: BudgetGuardOptions) {
    this.counter = options.counter;
    this.dailyBudget = options.dailyBudget ?? SYSTEM_SETTING_DEFAULTS.dailyQuota;
    this.provider = options.provider ?? 'KTO';
    this.clock = options.clock ?? (() => new Date());
  }

  async snapshot(): Promise<BudgetSnapshot> {
    const usedToday = await this.counter.countToday(this.provider, this.clock());
    return { dailyBudget: this.dailyBudget, usedToday };
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
 * `EXTRA_PROVIDER_DAILY_CAP`(개발계정 1,000 의 80%)이다. 소진량도 그 서비스의 제공자만 센다 —
 * 한 값으로 세면 새 서비스 호출이 국문 예산을 잠식하고 자기 한도는 세지 못한다.
 * 게이트는 부르려는 서비스의 것을 쓴다(`KTO_SERVICE_OF[operation]`).
 */
export function ktoBudgetGuard(
  service: KtoService,
  options: { readonly counter: DailyCallCounter; readonly dailyQuota: number; readonly clock?: () => Date },
): BudgetGuard {
  return new BudgetGuard({
    counter: options.counter,
    provider: KTO_PROVIDER_OF[service],
    dailyBudget: service === 'KOR' ? options.dailyQuota : EXTRA_PROVIDER_DAILY_CAP,
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
