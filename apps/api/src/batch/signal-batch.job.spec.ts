import { describe, expect, it, vi } from 'vitest';
import type { KtoService } from '@tourlint/shared';
import type { Signal, SignalWindow } from '../engine/signals';
import type { DemandSignalRepository, SignalType, StoredSignal } from '../persistence/demand-signal.repository';
import type { RadarRepository, WatchedProduct, WatchRegion } from '../radar/radar.repository';
import { SignalBatchJob, collectVisitorWindows, collectWindows } from './signal-batch.job';
import type { SignalRunner } from './signal-runner';

function product(over: Partial<WatchedProduct> = {}): WatchedProduct {
  return {
    productId: 1, name: '강릉 1박 2일', ldongRegnCd: '51', ldongSignguCd: '150',
    startDate: '2026-10-13', nights: 1, keywords: [], ...over,
  };
}

describe('신호 산출 대상 창', () => {
  it('상품 하나에 T1 · T2 창이 하나씩 나온다', () => {
    const w = collectWindows([product()], '2026-08-30');
    expect(w.map(([t]) => t)).toEqual(['T1', 'T2']);
  });

  it('🔴 같은 지역 · 같은 일정이면 창을 한 번만 만든다 — 안 접으면 같은 조회가 여러 번 나간다', () => {
    const w = collectWindows(
      [product({ productId: 1 }), product({ productId: 2 }), product({ productId: 3 })],
      '2026-08-30',
    );
    expect(w).toHaveLength(2);
  });

  it('지역이 같아도 여행일이 다르면 T2 창은 따로다 — T2 는 여행일에서 나온다', () => {
    const w = collectWindows(
      [product({ productId: 1, startDate: '2026-10-13' }),
       product({ productId: 2, startDate: '2026-11-20' })],
      '2026-08-30',
    );
    expect(w.filter(([t]) => t === 'T1')).toHaveLength(1);
    expect(w.filter(([t]) => t === 'T2')).toHaveLength(2);
  });

  it('시군구가 다르면 T1 창도 따로다', () => {
    const w = collectWindows(
      [product({ productId: 1, ldongSignguCd: '150' }),
       product({ productId: 2, ldongSignguCd: '210' })],
      '2026-08-30',
    );
    expect(w.filter(([t]) => t === 'T1')).toHaveLength(2);
  });

  it('T1 창은 오늘 기준 30일이다 (FR-RU-110)', () => {
    const [, w] = collectWindows([product()], '2026-08-30')[0] ?? [];
    expect(w?.from).toBe('2026-08-01');
    expect(w?.to).toBe('2026-08-30');
  });

  it('🔴 T1 창 하나에 그 지역 상품들의 계정 키워드를 합쳐 넘긴다 (FR-RU-112)', () => {
    /*
     * `demand_signal` 은 지역 단위다. 첫 상품의 키워드만 넘기면 같은 강릉 상품을 가진
     * 다른 계정의 키워드 일치가 저장되지 않는다.
     */
    const w = collectWindows(
      [product({ productId: 1, keywords: ['온천', '야행'] }),
       product({ productId: 2, keywords: ['커피', '온천'] }),
       product({ productId: 3, ldongSignguCd: '210', keywords: ['바다'] })],
      '2026-08-30',
    );
    const t1 = w.filter(([t]) => t === 'T1');
    expect(t1.map(([, win, keywords]) => [win.ldongSignguCd, keywords])).toEqual([
      ['150', ['야행', '온천', '커피']],
      ['210', ['바다']],
    ]);
  });

  it('T2 창에도 계정 키워드를 넘긴다 — 지역 카드의 "\'커피\' 행사" (UI-S7-015)', () => {
    const w = collectWindows([product({ keywords: ['온천'] })], '2026-08-30');
    expect(w.find(([t]) => t === 'T2')?.[2]).toEqual(['온천']);
  });

  it('T2 창은 여행기간 앞뒤 3일이다 (FR-RU-120)', () => {
    const t2 = collectWindows([product()], '2026-08-30').find(([t]) => t === 'T2');
    expect(t2?.[1].from).toBe('2026-10-10');
    expect(t2?.[1].to).toBe('2026-10-17');
  });
});

function watch(over: Partial<WatchRegion> = {}): WatchRegion {
  return { accountId: 7, ldongRegnCd: '51', ldongSignguCd: '150', month: '2026-10', keywords: [], ...over };
}

describe('관심 지역 창 (FR-MO-059)', () => {
  it('🔴 관심 지역 T1 은 같은 지역 상품 T1 과 한 창으로 접히고 키워드가 합쳐진다', () => {
    const w = collectWindows([product({ keywords: ['온천'] })], '2026-08-30', [watch({ keywords: ['커피'] })]);
    const t1 = w.filter(([t]) => t === 'T1');
    expect(t1).toHaveLength(1);
    expect(t1[0]?.[2]).toEqual(['온천', '커피']);
  });

  it('관심 지역 T2 는 그 달 1일 ~ 말일이고, 같은 지역 · 같은 달을 여러 계정이 봐도 한 창이다', () => {
    const w = collectWindows([], '2026-08-30', [
      watch({ accountId: 1, keywords: ['커피'] }),
      watch({ accountId: 2, keywords: ['야행'] }),
      watch({ accountId: 3, month: '2026-11' }),
    ]);
    const t2 = w.filter(([t]) => t === 'T2').map(([, win, keywords]) => [win.from, win.to, keywords]);
    expect(t2).toEqual([
      ['2026-10-01', '2026-10-31', ['야행', '커피']],
      ['2026-11-01', '2026-11-30', []],
    ]);
  });

  it('🔴 T3 는 지난해 같은 달끼리 묶는다 — 방문자수는 기간 하나에 1콜이다', () => {
    const groups = collectVisitorWindows([
      watch({ accountId: 1 }),
      watch({ accountId: 2 }), // 같은 지역 · 같은 달은 한 번만
      watch({ accountId: 3, ldongRegnCd: '36110', ldongSignguCd: null }),
      watch({ accountId: 4, month: '2026-11' }),
    ]);
    expect(groups.map((g) => g.map((w) => `${w.from}~${w.to} ${w.ldongRegnCd}:${w.ldongSignguCd}`))).toEqual([
      ['2025-10-01~2025-10-31 51:150', '2025-10-01~2025-10-31 36110:null'],
      ['2025-11-01~2025-11-30 51:150'],
    ]);
  });

  it('방문자수 코드로 옮길 수 없는 지역은 T3 를 부르지 않는다', () => {
    expect(collectVisitorWindows([watch({ ldongRegnCd: '51', ldongSignguCd: null })])).toEqual([]);
  });
});

describe('SignalBatchJob — 산출 · 저장 (가짜 러너 · 저장소)', () => {
  const NOW = new Date('2026-09-15T06:00:00+09:00');
  const signalOf = (window: SignalWindow, count = 1): Signal => ({ count, byType: {}, byKeyword: {}, window });

  function setup(options: {
    products?: WatchedProduct[];
    watches?: WatchRegion[];
    stored?: (type: SignalType, window: SignalWindow) => StoredSignal | null;
    t3?: (windows: readonly SignalWindow[]) => readonly (Signal | null)[] | null;
    budget?: (service: KtoService) => boolean;
  } = {}) {
    const runner = {
      t1: vi.fn(async (w: SignalWindow) => signalOf(w)),
      t2: vi.fn(async (w: SignalWindow) => signalOf(w)),
      t3: vi.fn(async (ws: readonly SignalWindow[]) => (options.t3 ?? ((all) => all.map((w) => signalOf(w, 500))))(ws)),
    };
    const upserts: [SignalType, Signal][] = [];
    const signals = {
      find: vi.fn(async (type: SignalType, w: SignalWindow) => options.stored?.(type, w) ?? null),
      upsert: vi.fn(async (type: SignalType, s: Signal) => { upserts.push([type, s]); }),
      pruneBefore: vi.fn(async () => 0),
    };
    const radar = {
      watchedRegions: vi.fn(async () => options.products ?? []),
      watchRegions: vi.fn(async (accountId?: number) =>
        (options.watches ?? []).filter((w) => accountId === undefined || w.accountId === accountId)),
    };
    const checked: KtoService[] = [];
    const hasBudget = async (service: KtoService): Promise<boolean> => {
      checked.push(service);
      return options.budget?.(service) ?? true;
    };
    const job = new SignalBatchJob({
      runner: runner as unknown as SignalRunner,
      signals: signals as unknown as DemandSignalRepository,
      radar: radar as unknown as RadarRepository,
      clock: () => NOW,
      hasBudget,
    });
    return { job, runner, upserts, checked, hasBudget };
  }

  it('🔴 관심 지역만 있는 계정도 배치가 산출한다 — 상품이 없다고 건너뛰지 않는다', async () => {
    const { job, upserts } = setup({ watches: [watch()] });
    const result = await job.run();
    expect(result.skippedReason).toBeNull();
    expect(upserts.map(([t]) => t).sort()).toEqual(['T1', 'T2', 'T3']);
  });

  it('상품도 관심 지역도 없으면 건너뛴다', async () => {
    expect((await setup().job.run()).skippedReason).toBe('NO_PRODUCTS');
  });

  it('🔴 T3 는 여러 지역이어도 달마다 한 번만 부르고, T3 예산은 방문자수 서비스로 본다', async () => {
    const { job, runner, checked } = setup({
      watches: [watch({ accountId: 1 }), watch({ accountId: 2, ldongSignguCd: '210' })],
    });
    await job.run();
    expect(runner.t3).toHaveBeenCalledTimes(1);
    expect(runner.t3.mock.calls[0]?.[0]).toHaveLength(2);
    expect(checked).toContain('VISITOR');
  });

  it('🔴 이미 센 T3 는 다시 부르지 않는다 — 지난해 자료는 바뀌지 않는다', async () => {
    const { job, runner } = setup({
      watches: [watch()],
      stored: (type, w) => (type === 'T3' ? { type, count: 1, byType: {}, byKeyword: {}, window: w, computedAt: NOW } : null),
    });
    await job.run();
    expect(runner.t3).not.toHaveBeenCalled();
  });

  it('🔴 방문자수 예산이 막히면 T3 만 멈추고 T1 · T2 는 산출한다', async () => {
    const { job, runner, upserts } = setup({ watches: [watch()], budget: (s) => s !== 'VISITOR' });
    await job.run();
    expect(runner.t3).not.toHaveBeenCalled();
    expect(upserts.map(([t]) => t).sort()).toEqual(['T1', 'T2']);
  });

  it('그 지역 줄이 없는 T3 는 실패로 세지 않고 행도 만들지 않는다', async () => {
    const { job, upserts } = setup({ watches: [watch()], t3: (ws) => ws.map(() => null) });
    const result = await job.run();
    expect(result.failed).toBe(0);
    expect(upserts.some(([t]) => t === 'T3')).toBe(false);
  });

  it('T3 조회가 실패하면 그 달 창들을 실패로 센다', async () => {
    const { job } = setup({ watches: [watch(), watch({ ldongSignguCd: '210' })], t3: () => null });
    expect((await job.run()).failed).toBe(2);
  });

  it('🔴 지금 산출은 오늘 이미 센 T1 · T2 를 다시 부르지 않고, 어제 센 것은 다시 센다', async () => {
    const yesterday = new Date('2026-09-14T06:00:00+09:00');
    const { job, runner, hasBudget } = setup({
      watches: [watch({ accountId: 7 }), watch({ accountId: 8, ldongSignguCd: '210' })],
      stored: (type, w) => (type === 'T1' ? { type, count: 1, byType: {}, byKeyword: {}, window: w, computedAt: NOW }
        : type === 'T2' ? { type, count: 1, byType: {}, byKeyword: {}, window: w, computedAt: yesterday } : null),
    });
    const result = await job.refreshWatchRegions(7, hasBudget);
    expect(runner.t1).not.toHaveBeenCalled();
    expect(runner.t2).toHaveBeenCalledTimes(1);
    // 다른 계정(8)의 관심 지역은 부르지 않는다
    expect(runner.t3.mock.calls[0]?.[0].map((w) => w.ldongSignguCd)).toEqual(['150']);
    expect(result.blocked).toBeNull();
  });
});

