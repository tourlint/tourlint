import { describe, expect, it } from 'vitest';
import type { ProductRegion } from '../radar/radar.repository';
import { collectWindows } from './signal-batch.job';

function product(over: Partial<ProductRegion> = {}): ProductRegion {
  return {
    productId: 1, name: '강릉 1박 2일', ldongRegnCd: '51', ldongSignguCd: '150',
    startDate: '2026-10-13', nights: 1, ...over,
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

  it('T2 창은 여행기간 앞뒤 3일이다 (FR-RU-120)', () => {
    const t2 = collectWindows([product()], '2026-08-30').find(([t]) => t === 'T2');
    expect(t2?.[1].from).toBe('2026-10-10');
    expect(t2?.[1].to).toBe('2026-10-17');
  });
});
