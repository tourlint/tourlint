import { Logger } from '@nestjs/common';
import type { KtoService } from '@tourlint/shared';
import {
  lastYearMonthWindow, monthWindow, t1Window, t2Window, T1_DEFAULT_DAYS, visitorRegionCode, type SignalWindow,
} from '../engine/signals';
import type { DemandSignalRepository } from '../persistence/demand-signal.repository';
import { regionKey } from '../persistence/demand-signal.repository';
import type { RadarRepository, WatchedProduct, WatchRegion } from '../radar/radar.repository';
import type { SignalRunner } from './signal-runner';
import { kstToday } from './sync-window';

/**
 * T1 · T2 · T3 수요 신호 산출 배치 (F14 · FR-RU-110 ~ 122 · FR-MO-059).
 *
 * 조회 시점에 공사를 부르지 않기로 했으므로(2026-08-30 결정) 여기서 미리 산출해
 * `demand_signal` 에 넣는다. 레이더 화면은 읽기만 한다.
 *
 * ## 변경 감지 배치와 분리한 이유
 *
 * `SyncBatchJob` 은 운영에서 매 평일 돌고 있다. 신호 산출을 그 안에 넣으면 신호 쪽
 * 실패가 변경 감지까지 끌고 내려간다 — 둘은 실패해도 서로 무관해야 한다.
 *
 * ## 같은 창은 한 번만 부른다
 *
 * 상품 열 개가 모두 강릉이면 T1 창이 같다. 지역·구간으로 접어서 부른다 —
 * 안 접으면 같은 조회가 열 번 나간다. 관심 키워드는 그 창을 쓰는 상품 · 관심 지역의 계정
 * 키워드를 합쳐 한 번에 판정한다 (FR-RU-112). `demand_signal` 은 지역 단위라 계정별로
 * 부르지 않는다.
 *
 * ## 관심 지역
 *
 * 계정이 등록한 관심 지역(시군구 + 달)마다 T1 · 그 달의 T2 · 지난해 같은 달의 T3 를 더한다
 * (FR-MO-059). T3 방문자수는 지역 조건이 없어 **기간 하나에 1콜**로 전국을 받아 지역마다
 * 거르고, 지난해 자료는 바뀌지 않으므로 이미 센 창은 다시 부르지 않는다.
 *
 * ## 실패는 그 창 하나에 가둔다
 *
 * 한 지역을 못 읽어도 나머지는 산출한다. 못 읽은 창은 **행을 만들지 않는다** —
 * 0 건으로 넣으면 「세어 보니 없었다」로 읽혀 「못 세어 봤다」와 구분이 사라진다.
 */

/** 그 공사 서비스의 예산이 남았는지. T1 · T2 는 국문 관광정보, T3 는 방문자수 예산이다 */
export type BudgetCheck = (service: KtoService) => Promise<boolean>;

export interface SignalBatchOptions {
  readonly runner: SignalRunner;
  readonly signals: DemandSignalRepository;
  readonly radar: RadarRepository;
  readonly clock?: () => Date;
  /** 자동 배치의 예산 게이트. 배치는 80% 에서 멈춘다 (FR-OP-003) */
  readonly hasBudget: BudgetCheck;
}

export interface SignalBatchResult {
  readonly computed: number;
  readonly failed: number;
  readonly skippedReason: 'NO_BUDGET' | 'NO_PRODUCTS' | null;
}

export interface SignalComputeResult {
  readonly computed: number;
  readonly failed: number;
  /** 예산에 막혀 멈춘 서비스. 끝까지 돌았으면 null */
  readonly blocked: KtoService | null;
}

/** 산출값 보관 기간. 지난 구간은 조회되지 않으므로 쌓아 둘 이유가 없다 */
export const KEEP_DAYS = 60;

export class SignalBatchJob {
  private readonly logger = new Logger(SignalBatchJob.name);
  private readonly runner: SignalRunner;
  private readonly signals: DemandSignalRepository;
  private readonly radar: RadarRepository;
  private readonly clock: () => Date;
  private readonly hasBudget: BudgetCheck;

  constructor(options: SignalBatchOptions) {
    this.runner = options.runner;
    this.signals = options.signals;
    this.radar = options.radar;
    this.clock = options.clock ?? ((): Date => new Date());
    this.hasBudget = options.hasBudget;
  }

  async run(): Promise<SignalBatchResult> {
    if (!await this.hasBudget('KOR')) return { computed: 0, failed: 0, skippedReason: 'NO_BUDGET' };

    const today = kstToday(this.clock());
    const [products, watches] = await Promise.all([
      this.radar.watchedRegions(today),
      this.radar.watchRegions(),
    ]);
    if (products.length === 0 && watches.length === 0) {
      return { computed: 0, failed: 0, skippedReason: 'NO_PRODUCTS' };
    }

    const { computed, failed } = await this.compute(
      collectWindows(products, today, watches), collectVisitorWindows(watches), this.hasBudget, null,
    );

    const removed = await this.signals.pruneBefore(daysAgo(today, KEEP_DAYS));
    if (removed > 0) this.logger.log(`오래된 신호 ${removed}건 정리`);

    return { computed, failed, skippedReason: null };
  }

  /**
   * 한 계정의 관심 지역 신호를 지금 산출한다 (FR-MO-059 · API 4-8 `region-signals/refresh`).
   *
   * 오늘 이미 센 T1 · T2 와 이미 있는 T3 는 다시 부르지 않는다 — 누를 때마다 지역당 3콜이
   * 나가지 않게. 예산 게이트는 호출자가 준다(사용자가 누른 것이라 100% 경계, `PLAN`).
   */
  async refreshWatchRegions(accountId: number, hasBudget: BudgetCheck): Promise<SignalComputeResult> {
    const today = kstToday(this.clock());
    const watches = await this.radar.watchRegions(accountId);
    return this.compute(collectWindows([], today, watches), collectVisitorWindows(watches), hasBudget, today);
  }

  /**
   * 창들을 산출해 저장한다. `skipComputedOn` 이 있으면 그날 이미 센 T1 · T2 는 건너뛴다.
   * T3 는 늘 이미 있는 창을 건너뛴다 — 지난해 자료라 다시 세도 같다.
   */
  private async compute(
    tasks: readonly SignalTask[],
    visitorGroups: readonly (readonly SignalWindow[])[],
    hasBudget: BudgetCheck,
    skipComputedOn: string | null,
  ): Promise<SignalComputeResult> {
    let computed = 0;
    let failed = 0;

    for (const [type, window, keywords] of tasks) {
      if (skipComputedOn !== null) {
        const existing = await this.signals.find(type, window);
        if (existing !== null && kstToday(existing.computedAt) === skipComputedOn) continue;
      }
      // 창 하나마다 예산을 다시 본다. 앞 창들이 다 써 버렸을 수 있다
      if (!await hasBudget('KOR')) return { computed, failed, blocked: 'KOR' };
      const signal = type === 'T1'
        ? await this.runner.t1(window, keywords)
        : await this.runner.t2(window, keywords);
      if (signal === null) {
        failed += 1;
        continue;
      }
      await this.signals.upsert(type, signal, this.clock());
      computed += 1;
    }

    for (const group of visitorGroups) {
      const pending: SignalWindow[] = [];
      for (const w of group) if (await this.signals.find('T3', w) === null) pending.push(w);
      if (pending.length === 0) continue;

      if (!await hasBudget('VISITOR')) return { computed, failed, blocked: 'VISITOR' };
      const results = await this.runner.t3(pending);
      if (results === null) {
        failed += pending.length;
        continue;
      }
      for (const signal of results) {
        // null 은 그 지역 줄이 없다는 뜻이다(지난해 코드와 안 이어짐). 실패가 아니고 행도 없다
        if (signal === null) continue;
        await this.signals.upsert('T3', signal, this.clock());
        computed += 1;
      }
    }
    return { computed, failed, blocked: null };
  }
}

/** 산출할 창 하나 — 종류 · 창 · 판정할 관심 키워드(정렬된 합집합) */
export type SignalTask = readonly ['T1' | 'T2', SignalWindow, readonly string[]];

/**
 * 산출할 T1 · T2 창 목록. 같은 창은 한 번만 담는다.
 *
 * T1 은 지역당 하나(오늘 기준 30일)이고, T2 는 **상품의 여행일에서 나오므로** 같은
 * 지역이라도 일정이 다르면 창이 다르다. 관심 지역은 T1 이 같은 지역 상품 창과 접히고,
 * T2 는 그 달 1일 ~ 말일이다. 창의 키워드는 그 창에 접힌 상품 · 관심 지역의 계정 키워드
 * 합집합이다 — 한 계정 것만 넘기면 같은 지역 다른 계정의 키워드 일치가 빠진다.
 */
export function collectWindows(
  products: readonly WatchedProduct[],
  today: string,
  watches: readonly WatchRegion[] = [],
): readonly SignalTask[] {
  const tasks = new Map<string, { type: 'T1' | 'T2'; window: SignalWindow; keywords: Set<string> }>();

  const add = (type: 'T1' | 'T2', window: SignalWindow | null, keywords: readonly string[]): void => {
    if (window === null || window.ldongRegnCd === null) return;
    const key = `${type}|${regionKey(window.ldongRegnCd, window.ldongSignguCd)}|${window.from}|${window.to}`;
    const task = tasks.get(key) ?? { type, window, keywords: new Set<string>() };
    for (const k of keywords) if (k.trim() !== '') task.keywords.add(k.trim());
    tasks.set(key, task);
  };

  for (const p of products) {
    const region = { ldongRegnCd: p.ldongRegnCd, ldongSignguCd: p.ldongSignguCd };
    add('T1', t1Window(today, region, T1_DEFAULT_DAYS), p.keywords);
    add('T2', t2Window(p.startDate, p.nights, region), p.keywords);
  }
  for (const w of watches) {
    const region = { ldongRegnCd: w.ldongRegnCd, ldongSignguCd: w.ldongSignguCd };
    add('T1', t1Window(today, region, T1_DEFAULT_DAYS), w.keywords);
    add('T2', monthWindow(w.month, region), w.keywords);
  }
  return [...tasks.values()].map((t) => [t.type, t.window, [...t.keywords].sort()] as const);
}

/**
 * 관심 지역 T3 창을 기간(지난해 그 달)별로 묶는다. 방문자수는 기간 하나에 1콜이다.
 *
 * 방문자수 코드로 옮길 수 없는 지역(시군구 없는 두 자리 시도)은 부르지 않는다. 코드는 있지만
 * 지난해 자료에 없는 지역은 불러 봐야 알 수 있다 — 결과가 null 이고 행을 만들지 않는다.
 */
export function collectVisitorWindows(watches: readonly WatchRegion[]): readonly (readonly SignalWindow[])[] {
  const groups = new Map<string, Map<string, SignalWindow>>();
  for (const w of watches) {
    const window = lastYearMonthWindow(w.month, { ldongRegnCd: w.ldongRegnCd, ldongSignguCd: w.ldongSignguCd });
    if (window === null || window.ldongRegnCd === null || visitorRegionCode(window) === null) continue;
    const period = `${window.from}|${window.to}`;
    const byRegion = groups.get(period) ?? new Map<string, SignalWindow>();
    byRegion.set(regionKey(window.ldongRegnCd, window.ldongSignguCd), window);
    groups.set(period, byRegion);
  }
  return [...groups.values()].map((byRegion) => [...byRegion.values()]);
}

function daysAgo(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
