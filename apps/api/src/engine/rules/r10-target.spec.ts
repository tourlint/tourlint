import {
  CONCEPT_KEY, LCLS_SYSTM2, RULE_CONSTANTS, TARGET_KEY, TARGET_PROFILE_SEED,
  type ContentTypeId, type MatchStatus,
} from '@tourlint/shared';
import { describe, expect, it } from 'vitest';
import { KOREAN_HOLIDAYS } from '../calendar/holidays';
import { R10TargetFitRule, missingTypes, summarize, type TargetProfileContext } from './r10-target';
import { DEFAULT_AUDIT_SETTINGS } from './types';
import type { AuditItem, Finding, MatchedContent } from './types';

const rule = new R10TargetFitRule();

let nextId = 1;
interface Spec {
  readonly cls?: string | null;
  readonly cls3?: string | null;
  readonly start?: string;
  readonly type?: ContentTypeId;
  readonly match?: MatchStatus;
}
function item(s: Spec = {}): AuditItem {
  const content: MatchedContent | null = s.type === undefined ? null : {
    ktoContentId: String(nextId), contentTypeId: s.type, normalized: null,
    showFlag: 1, eventPeriod: null, changeVerdict: null,
  };
  return {
    id: nextId++, dayNo: 1, seq: nextId, date: '2026-10-13',
    startTime: s.start ?? '10:00', endTime: '12:00', endTimeSource: 'INPUT',
    lclsSystm1: null, lclsSystm2: s.cls === undefined ? 'FD05' : s.cls,
    lclsSystm3: s.cls3 ?? null, mapX: null, mapY: null, itemType: 'SIGHT',
    placeLabel: '장소', matchStatus: s.match ?? 'CONFIRMED', content,
  };
}

function evaluate(items: readonly AuditItem[], targetProfile?: TargetProfileContext): readonly Finding[] {
  return rule.evaluate({
    productId: 1, items, holidays: KOREAN_HOLIDAYS,
    settings: DEFAULT_AUDIT_SETTINGS, targetProfile,
  });
}

const profile = (expectedLcls2: string[], expectsNight = false): TargetProfileContext =>
  ({ ok: true, targetKey: 'YOUTH_20S', conceptKey: 'EMOTIONAL', expectedLcls2, expectsNight });

describe('기대 프로파일 시드 (FR-RU-100)', () => {
  it('🔴 타깃 × 콘셉트 조합에 빠짐이 없다', () => {
    // 드롭다운에 있는 조합인데 행이 없으면 그 상품은 R10 을 영영 확인 불가로 남긴다
    expect(TARGET_PROFILE_SEED).toHaveLength(TARGET_KEY.length * CONCEPT_KEY.length);
    for (const t of TARGET_KEY) {
      for (const c of CONCEPT_KEY) {
        const found = TARGET_PROFILE_SEED.filter((p) => p.targetKey === t && p.conceptKey === c);
        expect(found, `${t} × ${c}`).toHaveLength(1);
      }
    }
  });

  it('🔴 기대 중분류가 전부 기준표에 있는 코드다', () => {
    for (const p of TARGET_PROFILE_SEED) {
      for (const code of p.expectedLcls2) {
        expect(LCLS_SYSTM2[code], `${p.targetKey}/${p.conceptKey} → ${code}`).toBeDefined();
      }
    }
  });

  it('한 칸에 셋씩이고 중복이 없다', () => {
    for (const p of TARGET_PROFILE_SEED) {
      expect(p.expectedLcls2, `${p.targetKey}/${p.conceptKey}`).toHaveLength(3);
      expect(new Set(p.expectedLcls2).size).toBe(3);
    }
  });

  it('숙박 · 추천코스는 기대에 넣지 않는다', () => {
    // 숙박은 1박 이상이면 항상 있어 판별력이 없고, 추천코스는 일정 항목 유형이 아니다
    for (const p of TARGET_PROFILE_SEED) {
      for (const code of p.expectedLcls2) {
        expect(code.startsWith('AC'), code).toBe(false);
        expect(code.startsWith('C01'), code).toBe(false);
      }
    }
  });
});

describe('일정 집계 (FR-RU-101)', () => {
  it('중분류 · 소분류 · contentTypeId 를 센다', () => {
    const s = summarize([
      item({ cls: 'FD05', cls3: 'FD050100', type: 39 }),
      item({ cls: 'FD05', cls3: 'FD050200', type: 39 }),
      item({ cls: 'VE01', cls3: 'VE010100', type: 12 }),
    ]);
    expect(s.byLcls2.get('FD05')).toBe(2);
    expect(s.byLcls3.get('FD050100')).toBe(1);
    expect(s.byContentType.get(39)).toBe(2);
    expect(s.byContentType.get(12)).toBe(1);
  });

  it('🔴 야간은 시작 시각으로 본다 — 늦게 끝나는 것은 야간 콘텐츠가 아니다', () => {
    expect(RULE_CONSTANTS.R10_NIGHT_SLOT_FROM).toBe('19:00');
    expect(summarize([item({ start: '18:59' })]).hasNight).toBe(false);
    expect(summarize([item({ start: '19:00' })]).hasNight).toBe(true);
  });

  it('결손은 0건인 유형만이다', () => {
    const s = summarize([item({ cls: 'FD05' })]);
    expect(missingTypes(s, ['FD05', 'VE01', 'EX02'])).toEqual(['VE01', 'EX02']);
    expect(missingTypes(s, ['FD05'])).toEqual([]);
  });
});

describe('R10 판정 (FR-RU-102 · 104)', () => {
  it('기대 유형이 0건이면 주의다', () => {
    const [f] = evaluate([item({ cls: 'FD05' })], profile(['FD05', 'VE01', 'EX02']));
    expect(f?.severity).toBe('WARNING');
    expect(f?.reasonCode).toBe('TARGET_MISMATCH');
    // 상품 단위 판정이라 지목할 항목이 없다
    expect(f?.targetItemId).toBeNull();
    expect(f?.requiresExternal).toBe(false);
  });

  it('결손 유형을 이름으로 밝힌다', () => {
    const [f] = evaluate([item({ cls: 'FD05' })], profile(['FD05', 'VE01']));
    expect(f?.message).toContain('20대 · 감성 상품인데');
    expect(f?.message).toContain('랜드마크관광');
    expect(f?.evidence).toMatchObject({ missingLcls2: ['VE01'] });
  });

  it('기대 유형이 다 있으면 내지 않는다', () => {
    expect(evaluate([item({ cls: 'FD05' }), item({ cls: 'VE01' })], profile(['FD05', 'VE01']))).toEqual([]);
  });

  it('🔴 야간을 기대하는데 19시 이후 일정이 없으면 결손이다', () => {
    const [f] = evaluate([item({ cls: 'FD05', start: '14:00' })], profile(['FD05'], true));
    expect(f?.severity).toBe('WARNING');
    expect(f?.message).toContain('19:00 이후 일정');
    expect(f?.evidence).toMatchObject({ expectsNight: true, hasNight: false, missingLcls2: [] });
  });

  it('야간을 기대하고 19시 이후 일정이 있으면 내지 않는다', () => {
    expect(evaluate([item({ cls: 'FD05', start: '20:00' })], profile(['FD05'], true))).toEqual([]);
  });

  it('야간을 기대하지 않으면 없어도 결손이 아니다', () => {
    expect(evaluate([item({ cls: 'FD05', start: '10:00' })], profile(['FD05'], false))).toEqual([]);
  });

  it('🔴 타깃 · 콘셉트를 안 적은 상품은 조용히 물러난다', () => {
    // 선택 입력이다. 안 적은 것을 결함이라 말할 근거가 없다
    expect(evaluate([item({ cls: 'HS01' })], undefined)).toEqual([]);
  });

  it('🔴 프로파일이 없으면 확인 불가다 — 비슷한 조합으로 대신 판정하지 않는다', () => {
    const [f] = evaluate([item({ cls: 'HS01' })], { ok: false, targetKey: 'SOLO', conceptKey: 'SHOPPING' });
    expect(f?.severity).toBe('UNVERIFIED');
    expect(f?.needsConfirmation).toBe(true);
    expect(f?.evidence).toMatchObject({ unit: 'RULE', targetKey: 'SOLO', conceptKey: 'SHOPPING' });
  });

  it('🔴 매칭이 확정되지 않은 항목은 세지 않는다', () => {
    // 붙은 콘텐츠가 없어 유형을 셀 수 없다. R05 가 이미 지적한다
    const [f] = evaluate([item({ cls: 'FD05', match: 'PENDING' }), item({ cls: 'FD05' })], profile(['VE01']));
    expect(f?.evidence).toMatchObject({ judgedCount: 1 });
  });

  it('셀 항목이 하나도 없으면 결손을 말하지 않는다', () => {
    expect(evaluate([item({ match: 'EXCLUDED' })], profile(['VE01']))).toEqual([]);
  });

  it('🔴 판매량 · 시장 반응 · 흥행을 말하지 않는다 (FR-RU-104)', () => {
    const [f] = evaluate([item({ cls: 'FD05' })], profile(['VE01', 'EX02'], true));
    const banned = ['판매', '흥행', '인기', '수요', '매출', '반응', '트렌드'];
    for (const word of banned) expect(f?.message, word).not.toContain(word);
  });

  it('같은 입력이면 메시지까지 같다 (NF-MT-001)', () => {
    const items = [item({ cls: 'FD05' })];
    const p = profile(['VE01', 'EX02'], true);
    const runs = [evaluate(items, p), evaluate(items, p), evaluate(items, p)];
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });
});
