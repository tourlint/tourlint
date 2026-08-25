import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { BUDGET_THRESHOLD_RATIO, SYSTEM_SETTING_DEFAULTS } from '@tourlint/shared';
import { localDateKey, type CallProvider } from '../external/api-call-log';
import { evaluateBudget } from '../external/budget-guard';
import { DB_POOL } from '../persistence/db';
import { PgApiCallLogger, type CallUsageRow } from '../persistence/api-call-log.repository';

/**
 * 호출 예산 · 활용 증빙 조회 (F15 · FR-OP-001 ~ 007).
 *
 * 이 표가 **공모전 API 활용 증빙**이다 (DR-LC-004). 화면이 숫자를 보여주려면 조회 경로가
 * 있어야 하는데 그동안 mock 이었다.
 *
 * 예산은 계정별이 아니라 **서비스 전체** 기준이다 — 단일 인증키를 전 계정이 공유한다
 * (PM-DA-006). 그래서 여기 어디에도 계정 조건이 없다.
 */

/** 예산 상태 3단 (API 설계 5-11) */
export const BUDGET_STATE = ['NORMAL', 'WARN', 'EXHAUSTED'] as const;
export type BudgetState = (typeof BUDGET_STATE)[number];

export interface BudgetView {
  readonly quotaDate: string;
  readonly dailyQuota: number;
  readonly used: number;
  readonly usageRatio: number;
  readonly state: BudgetState;
  readonly batchAutoStopped: boolean;
  readonly topOperations: readonly { readonly operation: string; readonly count: number }[];
  readonly resetAt: string;
}

export interface CallUsageView {
  readonly range: { readonly from: string; readonly to: string };
  readonly totals: {
    readonly count: number;
    readonly ok: number;
    readonly fail: number;
    readonly timeout: number;
  };
  readonly content: readonly CallUsageRow[];
  readonly totalElements: number;
}

@Injectable()
export class UsageService {
  private readonly logs: PgApiCallLogger;

  constructor(@Inject(DB_POOL) pool: Pool) {
    this.logs = new PgApiCallLogger(pool);
  }

  /**
   * 오늘의 예산 소진 상태 (FR-OP-005).
   *
   * 소진율 분자는 **당일 공사 호출 수**다. 카카오 · 기상청 · LLM 은 공사 예산과 별개 한도라
   * 같이 세면 800건 경계가 엉뚱하게 당겨진다 (API 설계 8-2 주석).
   */
  async budget(now: Date = new Date(), provider: CallProvider = 'KTO'): Promise<BudgetView> {
    const dailyQuota = SYSTEM_SETTING_DEFAULTS.dailyQuota;
    const used = await this.logs.countToday(provider, now);
    const decision = evaluateBudget({ dailyBudget: dailyQuota, usedToday: used }, 'USER_AUDIT');

    return {
      quotaDate: localDateKey(now),
      dailyQuota,
      used,
      // 화면이 퍼센트로 보여주므로 소수 셋째 자리면 충분하다
      usageRatio: Math.round(decision.ratio * 1000) / 1000,
      state: stateOf(decision.ratio),
      // 배치는 80% 에서 먼저 멈춘다 — 사용자 검수(100%)와 경계가 다르다 (FR-OP-003)
      batchAutoStopped: decision.ratio >= BUDGET_THRESHOLD_RATIO.WARN,
      topOperations: await this.logs.topOperations(provider, now),
      resetAt: nextMidnightKst(now),
    };
  }

  /** 일자별 · 오퍼레이션별 집계 (FR-OP-007). 기본 구간은 오늘 포함 최근 7일 */
  async calls(params: {
    readonly from?: string;
    readonly to?: string;
    readonly provider?: CallProvider;
    readonly now?: Date;
  } = {}): Promise<CallUsageView> {
    const now = params.now ?? new Date();
    const to = params.to ?? localDateKey(now);
    const from = params.from ?? shiftDays(to, -6);

    const content = await this.logs.dailyBreakdown({ from, to, provider: params.provider });
    return {
      range: { from, to },
      totals: {
        count: content.reduce((s, r) => s + r.count, 0),
        ok: content.reduce((s, r) => s + r.okCount, 0),
        fail: content.reduce((s, r) => s + r.failCount, 0),
        timeout: content.reduce((s, r) => s + r.timeoutCount, 0),
      },
      content,
      totalElements: content.length,
    };
  }
}

function stateOf(ratio: number): BudgetState {
  if (ratio >= BUDGET_THRESHOLD_RATIO.EXHAUSTED) return 'EXHAUSTED';
  if (ratio >= BUDGET_THRESHOLD_RATIO.WARN) return 'WARN';
  return 'NORMAL';
}

/**
 * 다음 예산 초기화 시각. **한국 시간 자정**이다.
 *
 * `quota_date` 를 KST 로 끊으므로(`localDateKey`) 초기화도 같은 경계여야 한다. UTC 자정으로
 * 적으면 화면이 "9시간 뒤 초기화" 라고 말하는데 실제로는 이미 넘어가 있다.
 */
function nextMidnightKst(now: Date): string {
  return `${shiftDays(localDateKey(now), 1)}T00:00:00+09:00`;
}

/** `YYYY-MM-DD` 에 일수를 더한다. 시간대에 기대지 않으려고 UTC 자정으로 계산한다 */
function shiftDays(isoDate: string, days: number): string {
  const base = new Date(`${isoDate}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}
