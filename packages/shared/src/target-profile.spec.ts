import { describe, expect, it } from 'vitest';
import { CONCEPT_KEY, TARGET_KEY, findProfile, isConceptKey, isTargetKey } from './target-profile';

describe('표준 프로파일 찾기 (FR-RU-100 · FR-PL-003)', () => {
  it('🔴 커플 · 감성은 카페 · 랜드마크 · 바다 강 풍경에 저녁 일정을 기대한다', () => {
    const p = findProfile('COUPLE', 'EMOTIONAL');
    expect(p?.expectedLcls2).toEqual(['FD05', 'VE01', 'NA02']);
    expect(p?.expectsNight).toBe(true);
  });

  it('🔴 타깃과 콘셉트를 둘 다 맞춰 찾는다 — 같은 콘셉트의 다른 타깃 행을 돌려주지 않는다', () => {
    // 가족(아이 동반) · 감성은 저녁 일정을 기대하지 않는다. 콘셉트만 보고 찾으면 20대 행이 나온다
    const p = findProfile('FAMILY_KIDS', 'EMOTIONAL');
    expect(p?.targetKey).toBe('FAMILY_KIDS');
    expect(p?.expectedLcls2).toEqual(['VE02', 'VE03', 'FD05']);
    expect(p?.expectsNight).toBe(false);
  });

  it('선택 목록의 63개 조합이 전부 한 행씩 찾아진다', () => {
    for (const t of TARGET_KEY) {
      for (const c of CONCEPT_KEY) {
        const p = findProfile(t, c);
        expect(p, `${t} · ${c}`).not.toBeNull();
        expect(p?.targetKey).toBe(t);
        expect(p?.conceptKey).toBe(c);
      }
    }
  });

  it('🔴 목록 밖 키는 null — 옛 자유 입력 값을 짐작해 붙이지 않는다', () => {
    expect(findProfile('커플', '감성')).toBeNull();
    expect(findProfile('couple', 'emotional')).toBeNull();
    expect(findProfile('COUPLE', '')).toBeNull();
  });

  it('키 가드는 문자열이 아닌 값을 거른다', () => {
    expect(isTargetKey('SENIOR')).toBe(true);
    expect(isTargetKey(null)).toBe(false);
    expect(isTargetKey(3)).toBe(false);
    expect(isConceptKey('HERITAGE')).toBe(true);
    expect(isConceptKey('SENIOR')).toBe(false);
  });
});
