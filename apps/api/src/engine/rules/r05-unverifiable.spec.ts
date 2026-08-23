import { describe, expect, it } from 'vitest';
import { KOREAN_HOLIDAYS } from '../calendar/holidays';
import { R05UnverifiableRule, findGap } from './r05-unverifiable';
import { DEFAULT_AUDIT_SETTINGS } from './types';
import type { AuditItem, Finding, MatchedContent } from './types';

const rule = new R05UnverifiableRule();

const content = (over: Partial<MatchedContent> = {}): MatchedContent => ({
  ktoContentId: '126508', contentTypeId: 12, normalized: null, showFlag: 1,
  eventPeriod: null, changeVerdict: null, ...over,
});

let nextId = 1;
const item = (over: Partial<AuditItem> = {}): AuditItem => ({
  id: nextId++, dayNo: 1, seq: 1, date: '2026-10-22', startTime: '10:00', endTime: '11:00',
  endTimeSource: 'INPUT', lclsSystm1: null, lclsSystm2: null, lclsSystm3: null,
  mapX: null, mapY: null, itemType: 'SIGHT', placeLabel: '오죽헌',
  matchStatus: 'CONFIRMED', content: content(), ...over,
});

const evaluate = (items: readonly AuditItem[]): readonly Finding[] =>
  rule.evaluate({ productId: 1, items, holidays: KOREAN_HOLIDAYS, settings: DEFAULT_AUDIT_SETTINGS });

describe('매칭이 확정되지 않은 항목 (FR-RU-051)', () => {
  it('결과에 한 줄도 안 남던 항목을 확인 불가로 남긴다', () => {
    // 이 항목은 R01 · R02 · R06 이 모두 물러난다. R05 가 없으면 통과한 것처럼 보인다
    const [f] = evaluate([item({ matchStatus: 'PENDING', content: null })]);
    expect(f?.severity).toBe('UNVERIFIED');
    expect(f?.reasonCode).toBe('PLACE_UNRESOLVED');
    expect(f?.ruleCode).toBe('R05');
    expect(f?.needsConfirmation).toBe(true);
  });

  it('사용자가 제외한 항목은 지적하지 않는다 — 모르는 게 아니라 볼 필요가 없는 것이다', () => {
    expect(evaluate([item({ matchStatus: 'EXCLUDED', content: null })])).toHaveLength(0);
  });

  it('확정된 항목은 R05 의 몫이 아니다', () => {
    expect(evaluate([item()])).toHaveLength(0);
  });
});

describe('행사 기간 결측 (FR-RU-023)', () => {
  const event = (period: MatchedContent['eventPeriod']): AuditItem =>
    item({ placeLabel: '경포 벚꽃축제', content: content({ contentTypeId: 15, eventPeriod: period }) });

  it('기간이 없으면 차단이 아니라 확인 불가다 — 없다는 게 끝났다는 뜻이 아니다', () => {
    const [f] = evaluate([event(null)]);
    expect(f?.severity).toBe('UNVERIFIED');
    expect(f?.reasonCode).toBe('PARSE_MISSING');
  });

  it('시작도 끝도 없으면 같다', () => {
    expect(evaluate([event({ start: null, end: null })])[0]?.reasonCode).toBe('PARSE_MISSING');
  });

  it('한쪽이라도 있으면 R02 가 판정한다 — 여기서 내면 목록에 두 줄로 뜬다', () => {
    expect(evaluate([event({ start: '2026-04-01', end: null })])).toHaveLength(0);
    expect(evaluate([event({ start: null, end: '2026-04-30' })])).toHaveLength(0);
  });

  it('행사가 아닌 유형에는 기간이라는 개념이 없다', () => {
    expect(evaluate([item({ content: content({ contentTypeId: 12, eventPeriod: null }) })])).toHaveLength(0);
  });
});

describe('경계', () => {
  it('조회 실패 항목은 러너가 사유와 함께 남긴다 — 여기서 또 내지 않는다', () => {
    expect(findGap(item({ matchStatus: 'CONFIRMED', content: null }))).toBeNull();
  });

  it('수정안을 만들지 않는다 (FR-RU-052)', () => {
    const [f] = evaluate([item({ matchStatus: 'PENDING', content: null })]);
    expect(f?.patches).toBeUndefined();
  });

  it('같은 입력에 같은 결과다 (NF-MT-001)', () => {
    const items = [item({ matchStatus: 'PENDING', content: null }), item()];
    expect(JSON.stringify(evaluate(items))).toBe(JSON.stringify(evaluate(items)));
  });

  it('항목마다 한 줄이다', () => {
    const items = [
      item({ matchStatus: 'PENDING', content: null }),
      item({ matchStatus: 'PENDING', content: null }),
    ];
    expect(evaluate(items)).toHaveLength(2);
  });
});
