import { describe, expect, it } from 'vitest';
import { DWELL_MINUTES_SEED, SETTING_DEFAULTS } from '@tourlint/shared';
import { addMinutes, resolveEndTime } from './dwell';

describe('resolveEndTime — 종료시간 보완 (FR-IN-011)', () => {
  it('입력값이 있으면 그대로 쓴다', () => {
    expect(resolveEndTime({ startTime: '10:00', endTime: '11:30', itemType: 'SIGHT', lclsSystm2: 'HS01' }))
      .toEqual({ endTime: '11:30', source: 'INPUT', dwellMinutes: null });
  });

  it('중분류가 표에 있으면 그 값으로 채운다', () => {
    // HS01 역사관광지 60분 — 경포대 · 굴산사지
    expect(resolveEndTime({ startTime: '10:00', endTime: null, itemType: 'SIGHT', lclsSystm2: 'HS01' }))
      .toEqual({ endTime: '11:00', source: 'DWELL_DEFAULT', dwellMinutes: 60 });
    // EV01 축제 120분
    expect(resolveEndTime({ startTime: '09:00', endTime: null, itemType: 'SIGHT', lclsSystm2: 'EV01' }))
      .toEqual({ endTime: '11:00', source: 'DWELL_DEFAULT', dwellMinutes: 120 });
  });

  it('매핑이 없으면 기본값 90분이고 출처가 다르다', () => {
    // 어떤 값이 어디서 왔는지 구분되지 않으면 "기본값 적용" 배지를 못 붙인다
    expect(resolveEndTime({ startTime: '10:00', endTime: null, itemType: 'SIGHT', lclsSystm2: 'ZZ99' }))
      .toEqual({ endTime: '11:30', source: 'DWELL_FALLBACK', dwellMinutes: 90 });
    expect(resolveEndTime({ startTime: '10:00', endTime: null, itemType: 'SIGHT', lclsSystm2: null }))
      .toMatchObject({ source: 'DWELL_FALLBACK', dwellMinutes: SETTING_DEFAULTS.dwellFallbackMinutes });
  });

  it('숙박은 보완하지 않는다 — 없는 시간 중복이 만들어진다 (FR-AU-011)', () => {
    // 입실 17:30 + 90분 = 19:00 구간이 생기면 다음 일정과 엉뚱하게 겹친다
    expect(resolveEndTime({ startTime: '17:30', endTime: null, itemType: 'LODGING', lclsSystm2: 'AC01' }))
      .toEqual({ endTime: null, source: 'INPUT', dwellMinutes: null });
  });

  it('체류시간 표에 숙박 중분류가 없다', () => {
    for (const key of ['AC01', 'AC03', 'AC05', 'AC06']) {
      expect(DWELL_MINUTES_SEED[key], key).toBeUndefined();
    }
  });

  it('픽스처가 쓰는 중분류 8개를 모두 담는다', () => {
    for (const key of ['HS01', 'VE03', 'VE07', 'VE12', 'EX06', 'EV01', 'FD01', 'SH06']) {
      expect(DWELL_MINUTES_SEED[key], key).toBeGreaterThan(0);
    }
  });

  it('같은 입력이면 같은 결과다 (NF-MT-001)', () => {
    const input = { startTime: '10:00', endTime: null, itemType: 'SIGHT' as const, lclsSystm2: 'VE07' };
    expect(resolveEndTime(input)).toEqual(resolveEndTime(input));
  });
});

describe('addMinutes', () => {
  it.each([['10:00', 60, '11:00'], ['10:30', 90, '12:00'], ['09:45', 15, '10:00']])(
    '%s + %i분 = %s', (t, m, e) => { expect(addMinutes(t, m)).toBe(e); },
  );

  it('자정을 넘기면 24:00 에서 멈춘다', () => {
    expect(addMinutes('23:30', 120)).toBe('24:00');
  });
});
