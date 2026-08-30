import { Logger } from '@nestjs/common';
import { t1Window, t2Window, T1_DEFAULT_DAYS, type SignalWindow } from '../engine/signals';
import type { DemandSignalRepository } from '../persistence/demand-signal.repository';
import { regionKey } from '../persistence/demand-signal.repository';
import type { ProductRegion, RadarRepository } from '../radar/radar.repository';
import type { SignalRunner } from './signal-runner';

/**
 * T1 · T2 수요 신호 산출 배치 (F14 · FR-RU-110 ~ 122).
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
 * 안 접으면 같은 조회가 열 번 나간다.
 *
 * ## 실패는 그 창 하나에 가둔다
 *
 * 한 지역을 못 읽어도 나머지는 산출한다. 못 읽은 창은 **행을 만들지 않는다** —
 * 0 건으로 넣으면 「세어 보니 없었다」로 읽혀 「못 세어 봤다」와 구분이 사라진다.
 */

export interface SignalBatchOptions {
  readonly runner: SignalRunner;
  readonly signals: DemandSignalRepository;
  readonly radar: RadarRepository;
  readonly clock?: () => Date;
  /** 예산이 남았는지. 배치는 80% 에서 멈춘다 (FR-OP-003) */
  readonly hasBudget: () => Promise<boolean>;
}

export interface SignalBatchResult {
  readonly computed: number;
  readonly failed: number;
  readonly skippedReason: 'NO_BUDGET' | 'NO_PRODUCTS' | null;
}

/** 산출값 보관 기간. 지난 구간은 조회되지 않으므로 쌓아 둘 이유가 없다 */
export const KEEP_DAYS = 60;

export class SignalBatchJob {
  private readonly logger = new Logger(SignalBatchJob.name);
  private readonly runner: SignalRunner;
  private readonly signals: DemandSignalRepository;
  private readonly radar: RadarRepository;
  private readonly clock: () => Date;
  private readonly hasBudget: () => Promise<boolean>;

  constructor(options: SignalBatchOptions) {
    this.runner = options.runner;
    this.signals = options.signals;
    this.radar = options.radar;
    this.clock = options.clock ?? ((): Date => new Date());
    this.hasBudget = options.hasBudget;
  }

  async run(): Promise<SignalBatchResult> {
    if (!await this.hasBudget()) return { computed: 0, failed: 0, skippedReason: 'NO_BUDGET' };

    const today = kstToday(this.clock());
    const products = await this.radar.watchedRegions(today);
    if (products.length === 0) return { computed: 0, failed: 0, skippedReason: 'NO_PRODUCTS' };

    const windows = collectWindows(products, today);
    let computed = 0;
    let failed = 0;

    for (const [type, window] of windows) {
      // 창 하나마다 예산을 다시 본다. 앞 창들이 다 써 버렸을 수 있다
      if (!await this.hasBudget()) break;
      const signal = type === 'T1' ? await this.runner.t1(window) : await this.runner.t2(window);
      if (signal === null) {
        failed += 1;
        continue;
      }
      await this.signals.upsert(type, signal, this.clock());
      computed += 1;
    }

    const removed = await this.signals.pruneBefore(daysAgo(today, KEEP_DAYS));
    if (removed > 0) this.logger.log(`오래된 신호 ${removed}건 정리`);

    return { computed, failed, skippedReason: null };
  }
}

/**
 * 산출할 창 목록. 같은 창은 한 번만 담는다.
 *
 * T1 은 지역당 하나(오늘 기준 30일)이고, T2 는 **상품의 여행일에서 나오므로** 같은
 * 지역이라도 일정이 다르면 창이 다르다.
 */
export function collectWindows(
  products: readonly ProductRegion[],
  today: string,
): readonly (readonly ['T1' | 'T2', SignalWindow])[] {
  const seen = new Set<string>();
  const out: (readonly ['T1' | 'T2', SignalWindow])[] = [];

  const add = (type: 'T1' | 'T2', window: SignalWindow | null): void => {
    if (window === null || window.ldongRegnCd === null) return;
    const key = `${type}|${regionKey(window.ldongRegnCd, window.ldongSignguCd)}|${window.from}|${window.to}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push([type, window]);
  };

  for (const p of products) {
    const region = { ldongRegnCd: p.ldongRegnCd, ldongSignguCd: p.ldongSignguCd };
    add('T1', t1Window(today, region, T1_DEFAULT_DAYS));
    add('T2', t2Window(p.startDate, p.nights, region));
  }
  return out;
}

/** KST 기준 오늘. 배치 날짜 판정은 한국 시간이다 */
function kstToday(now: Date): string {
  return new Date(now.getTime() + 9 * 60 * 60_000).toISOString().slice(0, 10);
}

function daysAgo(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
