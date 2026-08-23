import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KOREAN_HOLIDAYS } from '../calendar/holidays';
import { R04ImbalanceRule, countableItems } from './r04-imbalance';
import { DEFAULT_AUDIT_SETTINGS } from './types';
import type { AuditItem, Finding } from './types';

const rule = new R04ImbalanceRule();
const PRODUCTS = join(__dirname, '../../../../../fixtures/products');

interface Spec {
  readonly day?: number;
  readonly type?: AuditItem['itemType'];
  readonly ctid?: number;
  readonly l3?: string | null;
  readonly label?: string;
}

let nextId = 1;
function item(s: Spec = {}): AuditItem {
  const ctid = (s.ctid ?? 12) as 12;
  return {
    id: nextId++, dayNo: s.day ?? 1, seq: nextId, date: '2026-10-22',
    startTime: '10:00', endTime: '11:00', endTimeSource: 'INPUT',
    lclsSystm1: null, lclsSystm2: null, lclsSystm3: s.l3 === undefined ? 'AA010100' : s.l3,
    itemType: s.type ?? 'SIGHT', placeLabel: s.label ?? '장소', matchStatus: 'CONFIRMED',
    content: { ktoContentId: String(nextId), contentTypeId: ctid, normalized: null, showFlag: 1, eventPeriod: null, changeVerdict: null },
  };
}

const evaluate = (items: readonly AuditItem[], over: Partial<typeof DEFAULT_AUDIT_SETTINGS> = {}): readonly Finding[] =>
  rule.evaluate({
    productId: 1, items, holidays: KOREAN_HOLIDAYS,
    settings: { ...DEFAULT_AUDIT_SETTINGS, ...over },
  });

/** 상품 픽스처를 R04 입력으로 옮긴다 */
function fromFixture(file: string): AuditItem[] {
  const d = JSON.parse(readFileSync(join(PRODUCTS, file), 'utf8')) as {
    items: { dayNo: number; seq: number; startTime: string; endTime?: string | null;
             itemType: AuditItem['itemType']; placeLabel: string;
             contentId?: string; contentTypeId?: number; lclsSystm1?: string; lclsSystm2?: string; lclsSystm3?: string }[];
  };
  return d.items.map((i, idx) => ({
    id: idx + 1, dayNo: i.dayNo, seq: i.seq, date: '2026-10-22',
    startTime: i.startTime, endTime: i.endTime ?? null, endTimeSource: 'INPUT',
    lclsSystm1: i.lclsSystm1 ?? null, lclsSystm2: i.lclsSystm2 ?? null, lclsSystm3: i.lclsSystm3 ?? null,
    itemType: i.itemType, placeLabel: i.placeLabel, matchStatus: 'CONFIRMED',
    content: i.contentId === undefined ? null : {
      ktoContentId: i.contentId, contentTypeId: (i.contentTypeId ?? 12) as 12,
      normalized: null, showFlag: 1, eventPeriod: null, changeVerdict: null,
    },
  }));
}

describe('countableItems — 관광 항목만 센다 (FR-RU-040)', () => {
  it('식사 · 숙박 · 휴식 · 이동 · 자유시간을 뺀다', () => {
    const items = [
      item({ type: 'SIGHT' }), item({ type: 'MEAL' }), item({ type: 'LODGING' }),
      item({ type: 'REST' }), item({ type: 'MOVE' }), item({ type: 'FREE' }),
    ];
    expect(countableItems(items)).toHaveLength(1);
  });

  it('제외하지 않으면 정상 일정에도 상시 발동한다', () => {
    // 2박 3일은 식사만 최소 3회다 (2026.08.20 TP-01 검증)
    const meals = [item({ type: 'MEAL', ctid: 39 }), item({ type: 'MEAL', ctid: 39 }), item({ type: 'MEAL', ctid: 39 })];
    expect(evaluate(meals)).toHaveLength(0);
  });
});

describe('축 두 개 — contentTypeId 와 소분류', () => {
  it('contentTypeId 가 임계 이상이면 잡는다', () => {
    const [f] = evaluate([
      item({ ctid: 12, l3: 'AA010100' }), item({ ctid: 12, l3: 'BB010100' }), item({ ctid: 12, l3: 'CC010100' }),
    ]);
    expect(f).toMatchObject({ severity: 'WARNING', reasonCode: 'CONTENT_IMBALANCE', targetItemId: null });
    expect(f?.evidence).toMatchObject({ axis: 'contentTypeId', scope: 'PRODUCT', key: '12', count: 3 });
  });

  it('소분류가 임계 이상이면 잡는다 — 유형이 달라도', () => {
    const found = evaluate([
      item({ ctid: 12, l3: 'VE070100' }), item({ ctid: 14, l3: 'VE070100' }), item({ ctid: 28, l3: 'VE070100' }),
    ]);
    const bySub = found.find((f) => f.evidence.axis === 'lclsSystm3');
    expect(bySub?.evidence).toMatchObject({ key: 'VE070100', count: 3 });
  });

  it('분류를 모르는 항목은 세지 않는다 — 모르는 것끼리 묶으면 없는 편중이 생긴다', () => {
    const found = evaluate([
      item({ ctid: 12, l3: null }), item({ ctid: 14, l3: null }), item({ ctid: 28, l3: null }),
    ]);
    expect(found.filter((f) => f.evidence.axis === 'lclsSystm3')).toHaveLength(0);
  });
});

describe('범위 두 개 — 일차와 상품 전체', () => {
  it('일차 안에서만 몰리면 일차 단위로 잡는다', () => {
    const [f] = evaluate([
      item({ day: 1, ctid: 12 }), item({ day: 1, ctid: 12 }), item({ day: 1, ctid: 12 }),
      item({ day: 2, ctid: 14 }),
    ].map((i, n) => ({ ...i, lclsSystm3: `Z${n}` })));
    expect(f?.evidence).toMatchObject({ scope: 'PRODUCT', key: '12', count: 3 });
  });

  it('같은 반복을 일차와 상품에서 두 번 지적하지 않는다', () => {
    // 두 번 지적하면 감점이 두 배가 되고 사용자는 문제가 둘인 줄 안다
    const found = evaluate([
      item({ day: 1, ctid: 12, l3: 'A1' }), item({ day: 1, ctid: 12, l3: 'A2' }), item({ day: 1, ctid: 12, l3: 'A3' }),
    ]);
    const byType = found.filter((f) => f.evidence.axis === 'contentTypeId');
    expect(byType).toHaveLength(1);
    expect(byType[0]?.evidence.scope).toBe('PRODUCT');
  });

  it('상품 전체로는 임계 미만인데 하루에 몰리면 일차로 잡는다', () => {
    const found = evaluate([
      item({ day: 1, ctid: 12, l3: 'A1' }), item({ day: 1, ctid: 12, l3: 'A2' }), item({ day: 1, ctid: 12, l3: 'A3' }),
      item({ day: 2, ctid: 14, l3: 'B1' }),
    ], { r04Threshold: 3 });
    // 상품 전체 12가 3곳이라 PRODUCT 로 잡힌다
    expect(found.some((f) => f.evidence.scope === 'PRODUCT')).toBe(true);
  });
});

describe('임계치 (FR-RU-041)', () => {
  it.each([[2, 0], [3, 1]])('%i곳이면 finding %i건', (n, expected) => {
    const items = Array.from({ length: n }, (_, i) => item({ ctid: 12, l3: `X${i}` }));
    expect(evaluate(items).filter((f) => f.evidence.axis === 'contentTypeId')).toHaveLength(expected);
  });

  it('설정으로 조정된다', () => {
    const items = [item({ ctid: 12, l3: 'A' }), item({ ctid: 12, l3: 'B' })];
    expect(evaluate(items, { r04Threshold: 2 }).filter((f) => f.evidence.axis === 'contentTypeId')).toHaveLength(1);
  });
});

describe('반복이 의도된 콘셉트는 제외한다 (FR-RU-042)', () => {
  it('제외 키에 든 분류는 세지 않는다', () => {
    const items = [
      item({ ctid: 39, l3: 'FD020100' }), item({ ctid: 39, l3: 'FD020100' }), item({ ctid: 39, l3: 'FD020100' }),
    ];
    expect(evaluate(items)).not.toHaveLength(0);
    // "카페투어" 상품이면 카페 반복은 의도된 것이다
    expect(evaluate(items, { r04ExcludedKeys: ['39', 'FD020100'] })).toHaveLength(0);
  });
});

describe('회귀 정답셋 재현', () => {
  it('TP-01 — 관광 유형 12가 4곳이라 주의 1건', () => {
    const found = evaluate(fromFixture('TP-01_standard.json'));
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toMatchObject({ axis: 'contentTypeId', scope: 'PRODUCT', key: '12', count: 4 });
    // 39가 3곳이지만 전부 식사라 집계에서 빠진다
    expect(found[0]?.message).toContain('4곳');
  });

  it('TP-02 — 미발동', () => {
    expect(evaluate(fromFixture('TP-02_boundary.json'))).toHaveLength(0);
  });

  it('TP-03 — 미발동 (과탐 검증)', () => {
    expect(evaluate(fromFixture('TP-03_violation.json'))).toHaveLength(0);
  });

  it('픽스처에 소분류가 채워져 있다', () => {
    for (const f of ['TP-01_standard.json', 'TP-02_boundary.json', 'TP-03_violation.json']) {
      const matched = fromFixture(f).filter((i) => i.content !== null);
      expect(matched.length, f).toBeGreaterThan(0);
      for (const i of matched) {
        expect(i.lclsSystm1, `${f} ${i.placeLabel}`).toMatch(/^[A-Z]{2}$/);
        expect(i.lclsSystm3, `${f} ${i.placeLabel}`).toMatch(/^[A-Z]{2}\d{6}$/);
      }
    }
  });
});

describe('결정론성 (NF-MT-001)', () => {
  it('출력 순서가 고정된다', () => {
    const items = fromFixture('TP-01_standard.json');
    const runs = Array.from({ length: 3 }, () => evaluate(items));
    for (const r of runs) expect(r).toEqual(runs[0]);
  });

  it('규칙 메타는 계약이다', () => {
    expect(rule.code).toBe('R04');
    expect(rule.defaultSeverity).toBe('WARNING');
    expect(rule.requiresExternal).toBe(false);
  });
});
