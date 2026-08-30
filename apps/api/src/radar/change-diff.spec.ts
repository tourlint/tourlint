import { describe, expect, it } from 'vitest';
import { diffNormalized } from './change-diff';

const BASE = {
  alwaysOpen: false,
  weeklyClosed: ['MON'],
  openHours: { open: '09:00', close: '18:00', admissionCutoff: '17:30' },
  checkIn: null,
  checkOut: null,
};

describe('판독 결과 변화', () => {
  it('🔴 명세의 예시를 그대로 만든다 — 휴무일 월 → 월·화 (FR-MO-006)', () => {
    const after = { ...BASE, weeklyClosed: ['MON', 'TUE'] };
    expect(diffNormalized(BASE, after)).toEqual([
      { label: '휴무일', before: '월', after: '월·화' },
    ]);
  });

  it('🔴 명세의 예시를 그대로 만든다 — 운영시간 18시까지 → 17시까지 (FR-MO-006)', () => {
    const after = { ...BASE, openHours: { ...BASE.openHours, close: '17:00' } };
    expect(diffNormalized(BASE, after)).toContainEqual(
      { label: '운영시간', before: '09:00~18:00', after: '09:00~17:00' },
    );
  });

  it('🔴 요일 순서를 월요일부터로 맞춘다 — 입력 순서를 그대로 쓰면 「화·월」이 나온다', () => {
    // 같은 집합인데 순서만 다르면 변화가 아니다. 정렬을 빼면 매번 바뀐 것으로 뜬다
    const before = { ...BASE, weeklyClosed: ['MON', 'TUE'] };
    const after = { ...BASE, weeklyClosed: ['TUE', 'MON'] };
    expect(diffNormalized(before, after)).toEqual([]);
    expect(diffNormalized(BASE, after)[0]?.after).toBe('월·화');
  });

  it('연중무휴 전환을 잡는다', () => {
    const after = { ...BASE, alwaysOpen: true, weeklyClosed: [] };
    expect(diffNormalized(BASE, after)[0]).toEqual(
      { label: '휴무일', before: '월', after: '연중무휴' },
    );
  });

  it('입장마감 · 입실 · 퇴실도 본다', () => {
    const after = {
      ...BASE,
      openHours: { ...BASE.openHours, admissionCutoff: '17:00' },
      checkIn: '15:00', checkOut: '11:00',
    };
    const labels = diffNormalized(BASE, after).map((c) => c.label);
    expect(labels).toEqual(['입장마감', '입실', '퇴실']);
  });

  it('바뀐 것이 없으면 빈 배열이다', () => {
    expect(diffNormalized(BASE, { ...BASE })).toEqual([]);
  });

  it('🔴 한쪽이 없으면 비교하지 않는다 — 없는 것을 「변화 없음」으로 읽으면 안 된다', () => {
    /*
     * 검수 실행이 한 번뿐인 콘텐츠에는 비교할 이전 값이 없다. 빈 배열을 돌려주되
     * 호출자가 `hasReadableDiff` 로 「비교 못 함」과 「변화 없음」을 구분한다.
     */
    expect(diffNormalized(null, BASE)).toEqual([]);
    expect(diffNormalized(BASE, null)).toEqual([]);
    expect(diffNormalized(undefined, undefined)).toEqual([]);
  });

  it('🔴 모르는 값을 지어내지 않는다 — 파싱 안 된 시각은 「확인 불가」다', () => {
    const before = { ...BASE, openHours: { open: '상시', close: null } };
    const after = { ...BASE, openHours: { open: '09:00', close: '18:00' } };
    const line = diffNormalized(before, after).find((c) => c.label === '운영시간');
    expect(line?.before).toBe('확인 불가');
  });
});
