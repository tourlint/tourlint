import { describe, expect, it } from 'vitest';
import type { EndTimeSource } from '@tourlint/shared';
import { KOREAN_HOLIDAYS } from '../calendar/holidays';
import { R03TimeOverlapRule, overlapMinutes } from './r03-overlap';
import { DEFAULT_AUDIT_SETTINGS } from './types';
import type { AuditItem, Finding } from './types';

const rule = new R03TimeOverlapRule();

interface Spec {
  readonly id: number;
  readonly dayNo?: number;
  readonly seq: number;
  readonly start: string;
  readonly end: string | null;
  readonly label: string;
  readonly source?: EndTimeSource;
  readonly itemType?: AuditItem['itemType'];
}

function evaluate(specs: readonly Spec[]): readonly Finding[] {
  const items: AuditItem[] = specs.map((s) => ({
    id: s.id, dayNo: s.dayNo ?? 1, seq: s.seq, date: '2026-10-13',
    startTime: s.start, endTime: s.end, endTimeSource: s.source ?? 'INPUT',
    lclsSystm1: null, lclsSystm2: null, lclsSystm3: null, itemType: s.itemType ?? 'SIGHT', placeLabel: s.label,
    matchStatus: 'CONFIRMED',
    content: { ktoContentId: String(s.id), contentTypeId: 12, normalized: null, showFlag: 1, eventPeriod: null, changeVerdict: null },
  }));
  return rule.evaluate({ productId: 1, items, holidays: KOREAN_HOLIDAYS, settings: DEFAULT_AUDIT_SETTINGS });
}

describe('overlapMinutes — 1분이라도 겹치면 중복이다', () => {
  it.each([
    [{ start: '12:00', end: '13:00' }, { start: '12:30', end: '14:00' }, 30],
    [{ start: '12:00', end: '13:00' }, { start: '13:00', end: '14:00' }, 0],  // 맞닿은 것은 겹침이 아니다
    [{ start: '12:00', end: '13:00' }, { start: '12:59', end: '14:00' }, 1],
    [{ start: '12:00', end: '18:00' }, { start: '13:00', end: '14:00' }, 60], // 완전히 품는 경우
    [{ start: '12:00', end: '13:00' }, { start: '14:00', end: '15:00' }, 0],
  ])('%o vs %o → %i분', (a, b, expected) => {
    expect(overlapMinutes(a, b)).toBe(expected);
    expect(overlapMinutes(b, a)).toBe(expected);
  });
});

describe('R03 — 같은 일차 시간 중복', () => {
  it('기대값 표 TP-03 — 가람집(12:00~13:00) 과 오죽헌(12:30~14:00) 이 30분 겹친다', () => {
    const [f] = evaluate([
      { id: 2, seq: 2, start: '12:00', end: '13:00', label: '가람집옹심이' },
      { id: 3, seq: 3, start: '12:30', end: '14:00', label: '오죽헌·시립박물관' },
    ]);
    expect(f).toMatchObject({ severity: 'ERROR', reasonCode: 'TIME_OVERLAP', targetItemId: 2, targetItemId2: 3 });
    expect(f?.message).toContain('30분');
    expect(f?.evidence.overlapMinutes).toBe(30);
  });

  it('끝과 시작이 맞닿으면 겹치지 않는다', () => {
    expect(evaluate([
      { id: 1, seq: 1, start: '12:00', end: '13:00', label: 'A' },
      { id: 2, seq: 2, start: '13:00', end: '14:00', label: 'B' },
    ])).toHaveLength(0);
  });

  it('1분 겹쳐도 잡는다', () => {
    const [f] = evaluate([
      { id: 1, seq: 1, start: '12:00', end: '13:00', label: 'A' },
      { id: 2, seq: 2, start: '12:59', end: '14:00', label: 'B' },
    ]);
    expect(f?.evidence.overlapMinutes).toBe(1);
  });

  it('다른 일차끼리는 겹치지 않는다', () => {
    expect(evaluate([
      { id: 1, dayNo: 1, seq: 1, start: '12:00', end: '13:00', label: 'A' },
      { id: 2, dayNo: 2, seq: 1, start: '12:00', end: '13:00', label: 'B' },
    ])).toHaveLength(0);
  });

  it('세 항목이 서로 겹치면 쌍마다 하나씩 낸다', () => {
    const found = evaluate([
      { id: 1, seq: 1, start: '12:00', end: '14:00', label: 'A' },
      { id: 2, seq: 2, start: '12:30', end: '13:30', label: 'B' },
      { id: 3, seq: 3, start: '13:00', end: '15:00', label: 'C' },
    ]);
    expect(found).toHaveLength(3);
    expect(found.map((f) => [f.targetItemId, f.targetItemId2])).toEqual([[1, 2], [1, 3], [2, 3]]);
  });

  it('종료시간을 정할 수 없는 항목은 구간이 없어 겹칠 수 없다', () => {
    // 숙박은 입실 시각만 있다 — 체류시간을 더하면 없는 중복이 만들어진다
    expect(evaluate([
      { id: 1, seq: 1, start: '19:00', end: null, label: '강릉강변스테이', itemType: 'LODGING' },
      { id: 2, seq: 2, start: '19:00', end: '20:00', label: '야시장' },
    ])).toHaveLength(0);
  });

  describe('FR-RU-031 — 보완값으로 판정한 중복은 그 사실을 밝힌다', () => {
    it('기본 체류시간이 쓰였으면 메시지에 명시한다', () => {
      const [f] = evaluate([
        { id: 1, seq: 1, start: '12:00', end: '13:30', label: '박물관', source: 'DWELL_DEFAULT' },
        { id: 2, seq: 2, start: '13:00', end: '14:00', label: '카페' },
      ]);
      expect(f?.message).toContain('기본 체류시간');
      expect(f?.message).toContain('박물관');
      // 사용자가 입력하지 않은 값으로 지적받았으니 실제 소요시간을 확인해야 한다
      expect(f?.needsConfirmation).toBe(true);
    });

    it('둘 다 입력값이면 언급하지 않는다', () => {
      const [f] = evaluate([
        { id: 1, seq: 1, start: '12:00', end: '13:30', label: 'A' },
        { id: 2, seq: 2, start: '13:00', end: '14:00', label: 'B' },
      ]);
      expect(f?.message).not.toContain('기본 체류시간');
      expect(f?.needsConfirmation).toBe(false);
    });
  });

  it('입력 순서가 달라도 같은 결과다 — seq 로 고정한다 (NF-MT-001)', () => {
    const forward = evaluate([
      { id: 2, seq: 2, start: '12:00', end: '13:00', label: '가람집' },
      { id: 3, seq: 3, start: '12:30', end: '14:00', label: '오죽헌' },
    ]);
    const backward = evaluate([
      { id: 3, seq: 3, start: '12:30', end: '14:00', label: '오죽헌' },
      { id: 2, seq: 2, start: '12:00', end: '13:00', label: '가람집' },
    ]);
    expect(forward).toEqual(backward);
  });

  it('규칙 메타는 계약이다', () => {
    expect(rule.code).toBe('R03');
    expect(rule.defaultSeverity).toBe('ERROR');
    expect(rule.requiresExternal).toBe(false);
  });
});
