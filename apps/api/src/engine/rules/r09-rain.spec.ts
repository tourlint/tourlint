import { RULE_CONSTANTS, type MatchStatus } from '@tourlint/shared';
import { describe, expect, it } from 'vitest';
import { KOREAN_HOLIDAYS } from '../calendar/holidays';
import {
  R09RainRiskRule, coveringMax, judgeableItems, outdoorItems, outdoorRatio,
  type DailyRainOutlook,
} from './r09-rain';
import { DEFAULT_AUDIT_SETTINGS } from './types';
import type { AuditItem, Finding } from './types';

const rule = new R09RainRiskRule();
const MAPPING = DEFAULT_AUDIT_SETTINGS.r09IndoorOutdoor;

/** 시드 매핑에서 가져온 값 — 바뀌면 이 테스트가 먼저 깨진다 */
const OUT = 'HS01'; // 역사관광지 — 야외
const MIX = 'VE07'; // 박물관·기념관 — 혼재
const IN_ = 'EX06'; // 체험시설 — 실내

let nextId = 1;
interface Spec {
  readonly date?: string;
  readonly start?: string;
  readonly end?: string | null;
  readonly cls?: string | null;
  readonly match?: MatchStatus;
}
function item(s: Spec = {}): AuditItem {
  return {
    id: nextId++, dayNo: 1, seq: nextId, date: s.date ?? '2026-08-30',
    startTime: s.start ?? '10:00', endTime: s.end === undefined ? '12:00' : s.end,
    endTimeSource: 'INPUT', lclsSystm1: null, lclsSystm2: s.cls === undefined ? OUT : s.cls,
    lclsSystm3: null, mapX: 128.8, mapY: 37.7, itemType: 'SIGHT', placeLabel: '장소',
    matchStatus: s.match ?? 'CONFIRMED', content: null,
  };
}

function evaluate(items: readonly AuditItem[], outlooks: Record<string, DailyRainOutlook>): readonly Finding[] {
  return rule.evaluate({
    productId: 1, items, holidays: KOREAN_HOLIDAYS, settings: DEFAULT_AUDIT_SETTINGS,
    rainOutlooks: new Map(Object.entries(outlooks)),
  });
}

const mid = (p: number): DailyRainOutlook => ({ ok: true, source: 'MID', probability: p });
const short = (slots: Record<string, number>): DailyRainOutlook =>
  ({ ok: true, source: 'SHORT', slots: new Map(Object.entries(slots)) });

describe('야외 비중 (FR-RU-090)', () => {
  it('(야외 + 혼재 × 0.5) ÷ 전체', () => {
    const r = outdoorRatio([item({ cls: OUT }), item({ cls: MIX }), item({ cls: IN_ }), item({ cls: IN_ })], MAPPING);
    expect(r?.ratio).toBeCloseTo((1 + 0.5) / 4);
    expect(RULE_CONSTANTS.R09_MIXED_WEIGHT).toBe(0.5);
  });

  it('🔴 매핑이 없는 중분류는 분모에도 분자에도 넣지 않는다', () => {
    // 모르는 것을 실내로 세면 야외 비중이 낮아져 우천 리스크를 놓친다
    const r = outdoorRatio([item({ cls: OUT }), item({ cls: 'ZZ99' }), item({ cls: null })], MAPPING);
    expect(r?.ratio).toBe(1);
    expect(r?.mapped).toBe(1);
    expect(r?.unmapped).toBe(2);
  });

  it('셀 수 있는 항목이 하나도 없으면 null 이다 — 0 이 아니다', () => {
    expect(outdoorRatio([item({ cls: null })], MAPPING)).toBeNull();
    expect(outdoorRatio([], MAPPING)).toBeNull();
  });

  it('숙박은 매핑표에 있으므로 함께 센다 (체류시간 표와 다른 점)', () => {
    expect(MAPPING.AC01).toBe('INDOOR');
    const r = outdoorRatio([item({ cls: OUT }), item({ cls: 'AC01' })], MAPPING);
    expect(r?.ratio).toBe(0.5);
  });

  it('혼재는 야외 항목으로도 센다 — 비를 맞는 시간이 있다', () => {
    expect(outdoorItems([item({ cls: MIX }), item({ cls: IN_ })], MAPPING)).toHaveLength(1);
  });
});

describe('판정 대상', () => {
  it('🔴 제외 · 미확정 항목은 세지 않는다 — R05 가 이미 지적한다', () => {
    const items = [item({ match: 'CONFIRMED' }), item({ match: 'EXCLUDED' }), item({ match: 'PENDING' })];
    expect(judgeableItems(items)).toHaveLength(1);
  });

  it('판정 대상이 없는 날은 조용히 넘어간다', () => {
    expect(evaluate([item({ match: 'EXCLUDED' })], { '2026-08-30': mid(0.9) })).toEqual([]);
  });
});

describe('예보 시간대 커버리지 (FR-RU-091)', () => {
  it('일정 시간대를 덮는 칸 중 가장 큰 값', () => {
    const slots = new Map(Object.entries({ '0900': 0.2, '1000': 0.7, '1100': 0.3, '1500': 0.9 }));
    expect(coveringMax(slots, [item({ start: '10:00', end: '12:00' })])).toBeCloseTo(0.7);
  });

  it('🔴 덮는 칸이 없으면 0 이 아니라 null 이다', () => {
    // D+3 은 예보가 하루의 일부만 덮는다. 안 덮인 시간대를 0% 로 읽으면 비 오는 날이 통과한다
    const slots = new Map(Object.entries({ '0000': 0.9, '0300': 0.9 }));
    expect(coveringMax(slots, [item({ start: '10:00', end: '12:00' })])).toBeNull();
  });

  it('3시간 간격이면 한 칸이 세 시간을 덮는다', () => {
    // 2026.08.26 실측 — 당일은 1시간 간격, D+3 은 3시간 간격이었다
    const slots = new Map(Object.entries({ '0900': 0.8, '1200': 0.1, '1500': 0.1 }));
    expect(coveringMax(slots, [item({ start: '10:00', end: '11:00' })])).toBeCloseTo(0.8);
  });

  it('1시간 간격이면 없는 시각까지 넓히지 않는다', () => {
    const slots = new Map(Object.entries({ '0900': 0.8, '1000': 0.1, '1100': 0.1 }));
    expect(coveringMax(slots, [item({ start: '13:00', end: '14:00' })])).toBeNull();
  });

  it('종료시간이 없으면 시작 시각 한 점만 본다', () => {
    const slots = new Map(Object.entries({ '1000': 0.4, '1100': 0.9 }));
    expect(coveringMax(slots, [item({ start: '10:00', end: null })])).toBeCloseTo(0.4);
  });
});

describe('R09 판정 (FR-RU-092 · 093)', () => {
  it('야외 비중과 강수 지표가 둘 다 임계를 넘으면 주의다', () => {
    const [f] = evaluate([item({ cls: OUT }), item({ cls: OUT })], { '2026-08-30': mid(0.6) });
    expect(f?.severity).toBe('WARNING');
    expect(f?.reasonCode).toBe('RAIN_RISK');
    // 일차 단위 판정이라 지목할 항목이 없다
    expect(f?.targetItemId).toBeNull();
    expect(f?.externalSource).toBe('기상청');
    expect(f?.requiresExternal).toBe(true);
  });

  it('야외 비중이 낮으면 비가 와도 내지 않는다', () => {
    expect(evaluate([item({ cls: OUT }), item({ cls: IN_ })], { '2026-08-30': mid(0.9) })).toEqual([]);
  });

  it('강수 지표가 임계 미만이면 내지 않는다', () => {
    const below = RULE_CONSTANTS.R09_FORECAST_RAIN_THRESHOLD - 0.01;
    expect(evaluate([item({ cls: OUT })], { '2026-08-30': mid(below) })).toEqual([]);
  });

  it('평년은 임계가 따로다 — 예보보다 낮다', () => {
    expect(RULE_CONSTANTS.R09_CLIMATE_RAIN_THRESHOLD).toBeLessThan(RULE_CONSTANTS.R09_FORECAST_RAIN_THRESHOLD);
    const climate: DailyRainOutlook = {
      ok: true, source: 'CLIMATE', probability: 0.3, rainDays: 9.2, regionName: '강릉', month: 9,
    };
    const [f] = evaluate([item({ cls: OUT })], { '2026-08-30': climate });
    expect(f?.message).toContain('평년 기준 — 9월 강릉 강수일수 9.2일 (30%)');
  });

  it('판정 근거 종류를 문장에 밝힌다 (FR-RU-092)', () => {
    expect(evaluate([item({ cls: OUT })], { '2026-08-30': mid(0.7) })[0]?.message)
      .toContain('중기예보 기준 — 강수확률 70%');
    expect(evaluate([item({ cls: OUT })], { '2026-08-30': short({ '0900': 0.8, '1200': 0.8 }) })[0]?.message)
      .toContain('단기예보 기준 — 강수확률 80%');
  });

  it('근거를 조회하지 못한 날은 확인 불가다 — 정상이 아니다 (FR-RU-051)', () => {
    const [f] = evaluate([item({ cls: OUT })], {
      '2026-08-30': { ok: false, reasonCode: 'FORECAST_UNAVAILABLE' },
    });
    expect(f?.severity).toBe('UNVERIFIED');
    expect(f?.needsConfirmation).toBe(true);
    expect(f?.evidence).toMatchObject({ unit: 'RULE', date: '2026-08-30' });
  });

  it('🔴 야외 시간대를 못 덮으면 확인 불가로 남는다', () => {
    // 실측 스냅샷의 마지막 날은 00시 한 칸뿐이었다. 그 하루를 다 아는 것처럼 읽으면 안 된다
    const [f] = evaluate([item({ cls: OUT, start: '13:00', end: '15:00' })], {
      '2026-08-30': short({ '0000': 0.9 }),
    });
    expect(f?.severity).toBe('UNVERIFIED');
    expect(f?.message).toContain('야외 일정 시간대를 덮는 예보가 없습니다');
  });

  it('중분류가 하나도 없으면 확인 불가다', () => {
    const [f] = evaluate([item({ cls: null })], { '2026-08-30': mid(0.9) });
    expect(f?.severity).toBe('UNVERIFIED');
    expect(f?.reasonCode).toBe('PLACE_UNRESOLVED');
  });

  it('날짜별로 따로 판정한다 — 출발일이 아니라 각 여행 일자다 (FR-RU-091)', () => {
    const findings = evaluate(
      [item({ date: '2026-08-30', cls: OUT }), item({ date: '2026-08-31', cls: OUT })],
      { '2026-08-30': mid(0.9), '2026-08-31': mid(0.1) },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence).toMatchObject({ date: '2026-08-30' });
  });

  it('근거가 없으면 규칙 자체가 물러난다', () => {
    expect(rule.evaluate({
      productId: 1, items: [item({ cls: OUT })], holidays: KOREAN_HOLIDAYS,
      settings: DEFAULT_AUDIT_SETTINGS,
    })).toEqual([]);
  });

  it('같은 입력이면 메시지까지 같다 (NF-MT-001)', () => {
    const items = [item({ date: '2026-08-31', cls: OUT }), item({ date: '2026-08-30', cls: OUT })];
    const outlooks = { '2026-08-30': mid(0.9), '2026-08-31': mid(0.9) };
    const runs = [evaluate(items, outlooks), evaluate(items, outlooks), evaluate(items, outlooks)];
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
    // 날짜 순서도 고정이다
    expect(runs[0]?.map((f) => f.evidence.date)).toEqual(['2026-08-30', '2026-08-31']);
  });
});
