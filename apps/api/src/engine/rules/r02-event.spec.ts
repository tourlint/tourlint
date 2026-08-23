import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KOREAN_HOLIDAYS } from '../calendar/holidays';
import { parseIsoDate } from '../calendar/dates';
import { R02EventPeriodRule, evaluateEventPeriod } from './r02-event';
import { DEFAULT_AUDIT_SETTINGS } from './types';
import type { AuditItem, Finding } from './types';

const rule = new R02EventPeriodRule();
const at = (iso: string): NonNullable<ReturnType<typeof parseIsoDate>> => {
  const d = parseIsoDate(iso);
  if (d === null) throw new Error(iso);
  return d;
};

function festival(date: string, period: { start: string | null; end: string | null } | null, contentTypeId = 15): readonly Finding[] {
  const item: AuditItem = {
    id: 1, dayNo: 1, seq: 1, date, startTime: '09:00', endTime: '10:00',
    endTimeSource: 'INPUT', lclsSystm1: 'EV', lclsSystm2: 'EV01', lclsSystm3: 'EV010200', mapX: null, mapY: null, itemType: 'SIGHT',
    placeLabel: '경포벚꽃축제', matchStatus: 'CONFIRMED',
    content: {
      ktoContentId: '695592', contentTypeId: contentTypeId as 15,
      normalized: null, showFlag: 1, eventPeriod: period, changeVerdict: null,
    },
  };
  return rule.evaluate({ productId: 1, items: [item], holidays: KOREAN_HOLIDAYS, settings: DEFAULT_AUDIT_SETTINGS });
}

describe('evaluateEventPeriod — 경계는 포함이다', () => {
  const p = { start: '2026-04-04', end: '2026-04-11' };

  it.each([
    ['2026-04-04', 'IN_PERIOD'], // 개막일 당일
    ['2026-04-07', 'IN_PERIOD'],
    ['2026-04-11', 'IN_PERIOD'], // 폐막일 당일
    ['2026-04-12', 'ENDED'],
    ['2026-04-03', 'NOT_STARTED'],
    ['2026-10-14', 'ENDED'],
  ])('%s → %s', (iso, expected) => {
    expect(evaluateEventPeriod(at(iso), p)).toBe(expected);
  });

  it('한쪽만 알아도 답할 수 있는 건 답한다', () => {
    expect(evaluateEventPeriod(at('2026-10-14'), { start: null, end: '2026-04-11' })).toBe('ENDED');
    expect(evaluateEventPeriod(at('2026-01-01'), { start: '2026-04-04', end: null })).toBe('NOT_STARTED');
    expect(evaluateEventPeriod(at('2026-04-07'), { start: '2026-04-04', end: null })).toBe('IN_PERIOD');
  });

  it('둘 다 없으면 모른다', () => {
    expect(evaluateEventPeriod(at('2026-10-14'), { start: null, end: null })).toBe('UNKNOWN');
  });

  it('해를 넘긴 행사도 맞다', () => {
    const winter = { start: '2026-12-20', end: '2027-01-10' };
    expect(evaluateEventPeriod(at('2027-01-05'), winter)).toBe('IN_PERIOD');
    expect(evaluateEventPeriod(at('2027-01-11'), winter)).toBe('ENDED');
  });
});

describe('R02 — 행사 기간 불일치', () => {
  it('끝난 행사는 차단이고 종료 사실을 메시지에 담는다', () => {
    // 실측: 경포벚꽃축제(695592) 2026-04-04 ~ 04-11 · TP-03 2일차 방문 10/14
    const [f] = festival('2026-10-14', { start: '2026-04-04', end: '2026-04-11' });
    expect(f).toMatchObject({ severity: 'BLOCKER', reasonCode: 'EVENT_ENDED', ruleCode: 'R02' });
    expect(f?.message).toContain('2026-04-11');
    expect(f?.message).toContain('끝났습니다');
  });

  it('아직 시작 전이면 사유코드가 다르다 — 종료 후인지 개시 전인지 구분한다', () => {
    const [f] = festival('2026-03-01', { start: '2026-04-04', end: '2026-04-11' });
    expect(f).toMatchObject({ severity: 'BLOCKER', reasonCode: 'EVENT_NOT_STARTED' });
    expect(f?.message).toContain('시작합니다');
  });

  it('기간 안이면 finding 이 없다', () => {
    expect(festival('2026-04-07', { start: '2026-04-04', end: '2026-04-11' })).toHaveLength(0);
  });

  it('FR-RU-023 — 행사 일자가 결측이면 차단하지 않고 R05 에 넘긴다', () => {
    /*
     * 모르는 것을 틀렸다고 말하지 않는다. 다만 확인 불가를 여기서 내지는 않는다 —
     * 같은 항목이 확인 필요 목록에 두 줄로 뜬다. R05 가 `PARSE_MISSING` 으로 올린다
     * (`r05-unverifiable.spec.ts` 의 "행사 기간 결측").
     */
    for (const period of [null, { start: null, end: null }]) {
      expect(festival('2026-10-14', period)).toHaveLength(0);
    }
  });

  it('날짜가 있는데 해석이 안 되면 확인 불가고, 행사 종료라고 말하지 않는다', () => {
    /*
     * R05 는 "값이 없는" 경우를 맡는다. 값은 있는데 못 읽는 경우는 여기 남는다.
     * `EVENT_ENDED` 를 달면 화면에 "행사 종료" 로 뜬다 — 끝났다고 말하려면 끝난 날짜를
     * 봤어야 하는데, 우리가 본 건 읽을 수 없는 문자열뿐이다
     */
    const [f] = festival('2026-10-14', { start: '2026-13-45', end: null });
    expect(f).toMatchObject({ severity: 'UNVERIFIED', reasonCode: 'PARSE_MISSING', ruleCode: 'R02' });
    expect(f?.message).not.toContain('끝났');
  });

  it('한쪽만 정상이면 그걸로 판정한다 — 끝 날짜만 있어도 종료는 말할 수 있다', () => {
    const [f] = festival('2026-10-14', { start: null, end: '2026-04-11' });
    expect(f).toMatchObject({ severity: 'BLOCKER', reasonCode: 'EVENT_ENDED' });
  });

  it('행사가 아닌 콘텐츠에는 개념 자체가 없다', () => {
    expect(festival('2026-10-14', { start: '2026-04-04', end: '2026-04-11' }, 12)).toHaveLength(0);
  });

  it('실호출 스냅샷의 기간으로 판정한다', () => {
    const raw: unknown = JSON.parse(readFileSync(join(__dirname, '../../../../../fixtures/kto/type15_695592.json'), 'utf8'));
    const it0 = (raw as { response: { body: { items: { item: unknown } } } }).response.body.items.item;
    const item = (Array.isArray(it0) ? it0[0] : it0) as Record<string, string>;
    // 공사는 YYYYMMDD 로 준다. 러너가 YYYY-MM-DD 로 옮겨 넣는다
    const iso = (v: string): string => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    expect(iso(item.eventstartdate as string)).toBe('2026-04-04');
    expect(iso(item.eventenddate as string)).toBe('2026-04-11');

    const [f] = festival('2026-10-14', { start: iso(item.eventstartdate as string), end: iso(item.eventenddate as string) });
    expect(f?.reasonCode).toBe('EVENT_ENDED');
  });

  it('규칙 메타는 계약이다', () => {
    expect(rule.code).toBe('R02');
    expect(rule.defaultSeverity).toBe('BLOCKER');
    expect(rule.requiresExternal).toBe(false);
  });

  it('결정론성 (NF-MT-001)', () => {
    const runs = Array.from({ length: 3 }, () => festival('2026-10-14', { start: '2026-04-04', end: '2026-04-11' }));
    for (const r of runs) expect(r).toEqual(runs[0]);
  });
});
