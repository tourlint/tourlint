import { describe, expect, it } from 'vitest';
import { DWELL_MINUTES_SEED, INDOOR_OUTDOOR_SEED } from './constants';
import { LCLS_SYSTM1, LCLS_SYSTM2, isKnownLcls2, lcls2Of } from './lcls-systm';

describe('신분류체계 기준표 (EI-KT-001)', () => {
  it('대분류 10종 · 중분류 59행', () => {
    // 명세가 「중분류(59개)」라고 못 박아 둔 수다 (FR-RU-090)
    expect(Object.keys(LCLS_SYSTM1)).toHaveLength(10);
    expect(Object.keys(LCLS_SYSTM2)).toHaveLength(59);
  });

  it('모든 중분류가 실재하는 대분류에 붙는다', () => {
    for (const [code, v] of Object.entries(LCLS_SYSTM2)) {
      expect(LCLS_SYSTM1[v.parent], `${code}`).toBeDefined();
      expect(code.startsWith(v.parent), `${code} ← ${v.parent}`).toBe(true);
    }
  });

  it('🔴 체류시간 · 실내외 시드가 기준표에 없는 코드를 쓰지 않는다', () => {
    // 표를 59행으로 넓힐 때 엉뚱한 코드에 값을 넣는 것을 막는다
    for (const code of Object.keys(DWELL_MINUTES_SEED)) expect(isKnownLcls2(code), code).toBe(true);
    for (const code of Object.keys(INDOOR_OUTDOOR_SEED)) expect(isKnownLcls2(code), code).toBe(true);
  });

  it('숙박에는 체류시간을 두지 않는다 (FR-AU-011)', () => {
    // 입실 17:30 + 90분 = 19:00 같은 없는 중복을 만들지 않기 위해서다
    for (const code of lcls2Of('AC')) expect(DWELL_MINUTES_SEED[code]).toBeUndefined();
  });

  it('모르는 코드는 기준표에 없다고 답한다', () => {
    expect(isKnownLcls2('ZZ99')).toBe(false);
    expect(isKnownLcls2(null)).toBe(false);
  });

  it('대분류로 중분류를 찾는다', () => {
    expect(lcls2Of('AC')).toEqual(['AC01', 'AC02', 'AC03', 'AC04', 'AC05', 'AC06']);
    expect(lcls2Of('VE')).toHaveLength(12);
  });
});
