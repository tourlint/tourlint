import { describe, expect, it } from 'vitest';
import { mergeFallback, parseFallbackResult } from './fallback';
import type { NormalizedOperatingInfo, UnparsedFragment } from './types';

const FRAG: UnparsedFragment = { fragment: '설 연휴 첫날 휴관', reason: 'CONDITIONAL', affects: ['weeklyClosed'] };

function base(over: Partial<NormalizedOperatingInfo> = {}): NormalizedOperatingInfo {
  return {
    schemaVersion: '1.0', sourceFieldNames: ['restdate'],
    alwaysOpen: false, weeklyClosed: [], nthWeekday: [], fixedClosed: [],
    holidayRule: [], conditionalRule: [], partialClosed: [],
    openHours: null, dayOfWeekHours: [], seasonalHours: [],
    checkIn: null, checkOut: null,
    confidence: { overall: 'UNPARSED', byPath: {} },
    unparsed: [FRAG],
    ...over,
  } as NormalizedOperatingInfo;
}

describe('LLM 응답 검증', () => {
  it('요일 · 공휴일 · 고정휴무 · 운영시간을 읽는다', () => {
    const p = parseFallbackResult({
      weeklyClosed: ['MON', 'TUE'], holidayRule: ['CHUSEOK'], fixedClosed: ['01-01'],
      openHours: { open: '09:00', close: '18:00', breaks: [{ from: '12:00', to: '13:00' }], admissionCutoff: '17:30' },
    });
    expect(p?.weeklyClosed).toEqual(['MON', 'TUE']);
    expect(p?.openHours?.admissionCutoff).toBe('17:30');
    expect(p?.openHours?.breaks).toEqual([{ from: '12:00', to: '13:00' }]);
  });

  it('🔴 모양이 어긋나면 통째로 버린다 — 나머지 절반을 믿을 근거가 없다', () => {
    // 요일 하나가 틀렸는데 운영시간은 멀쩡한 응답
    expect(parseFallbackResult({
      weeklyClosed: ['MONDAY'],
      openHours: { open: '09:00', close: '18:00' },
    })).toBeNull();
  });

  it('🔴 시각 형식을 강제한다 — 잘못 읽으면 잘못된 차단이 된다 (PM-NG-001)', () => {
    for (const bad of ['9:00', '25:00', '09:60', '오전 9시', '']) {
      expect(parseFallbackResult({ openHours: { open: bad, close: '18:00' } }), bad).toBeNull();
    }
  });

  it('고정휴무는 MM-DD 여야 한다', () => {
    expect(parseFallbackResult({ fixedClosed: ['1-1'] })).toBeNull();
    expect(parseFallbackResult({ fixedClosed: ['13-01'] })).toBeNull();
    expect(parseFallbackResult({ fixedClosed: ['01-01'] })?.fixedClosed).toEqual(['01-01']);
  });

  it('🔴 아무것도 안 읽어 온 응답은 실패로 본다', () => {
    expect(parseFallbackResult({})).toBeNull();
    expect(parseFallbackResult({ weeklyClosed: [], holidayRule: [] })).toBeNull();
  });

  it('객체가 아니면 버린다', () => {
    for (const bad of [null, [], 'x', 3, undefined]) expect(parseFallbackResult(bad)).toBeNull();
  });
});

describe('정규화 결과 병합', () => {
  const parsed = parseFallbackResult({ weeklyClosed: ['MON'] })!;

  it('빈 축을 채우고 조각을 미해석에서 뺀다', () => {
    const out = mergeFallback(base(), FRAG, parsed);
    expect(out.weeklyClosed).toEqual(['MON']);
    expect(out.unparsed).toEqual([]);
    expect(out.confidence.byPath.weeklyClosed).toBe('CONFIRMED');
  });

  it('🔴 사전 파서가 읽은 축을 덮지 않는다 — 회귀 정답셋이 밀린다', () => {
    const withValue = base({
      weeklyClosed: ['WED'],
      confidence: { overall: 'CONFIRMED', byPath: { weeklyClosed: 'CONFIRMED' } },
    });
    const out = mergeFallback(withValue, FRAG, parsed);
    expect(out.weeklyClosed).toEqual(['WED']);
    // 아무 축도 못 채웠으므로 조각은 여전히 미해석이다
    expect(out.unparsed).toEqual([FRAG]);
  });

  it('🔴 운영시간도 덮지 않는다', () => {
    const hours = { open: '10:00', close: '19:00', breaks: [], admissionCutoff: null };
    const withHours = base({ openHours: hours });
    const p = parseFallbackResult({ openHours: { open: '08:00', close: '22:00' } })!;
    expect(mergeFallback(withHours, FRAG, p).openHours).toEqual(hours);
  });

  it('🔴 조건부로 분류되면 ESTIMATED 다 (DR-NM-031)', () => {
    const cond = parseFallbackResult({ weeklyClosed: ['MON'], conditional: true })!;
    expect(mergeFallback(base(), FRAG, cond).confidence.byPath.weeklyClosed).toBe('ESTIMATED');
  });

  it('🔴 휴무를 채우면 연중무휴를 내린다 — 둘이 같이 참이면 스키마 모순이다', () => {
    const open = base({ alwaysOpen: true });
    expect(mergeFallback(open, FRAG, parsed).alwaysOpen).toBe(false);
  });

  it('미해석 조각이 남아 있으면 전체 신뢰도가 CONFIRMED 가 되지 않는다', () => {
    const other: UnparsedFragment = { fragment: '기타', reason: 'REFERENCE', affects: [] };
    const two = base({ unparsed: [FRAG, other] });
    expect(mergeFallback(two, FRAG, parsed).confidence.overall).not.toBe('CONFIRMED');
  });

  it('여러 조각을 이어서 합쳐도 각각 제 축만 채운다', () => {
    const f2: UnparsedFragment = { fragment: '09시~18시', reason: 'MISSING', affects: ['openHours'] };
    let out = mergeFallback(base({ unparsed: [FRAG, f2] }), FRAG, parsed);
    out = mergeFallback(out, f2, parseFallbackResult({ openHours: { open: '09:00', close: '18:00' } })!);
    expect(out.weeklyClosed).toEqual(['MON']);
    expect(out.openHours?.open).toBe('09:00');
    expect(out.unparsed).toEqual([]);
    expect(out.confidence.overall).toBe('CONFIRMED');
  });
});
