import { describe, expect, it } from 'vitest';
import { describeNotification, koreanDay, modifiedOn, overlapDays, type NotificationFacts } from './notification-detail';

const facts = (over: Partial<NotificationFacts> = {}): NotificationFacts => ({
  condition: 1, hidden: false, schedule: null, changes: [], hasBefore: true, hasAfter: true,
  eventPeriod: null, overlapDays: [], ...over,
});

describe('알림이 실제로 말할 수 있는 것 (#703 · UI-S7-003 · 004)', () => {
  it('🔴 무엇이 바뀌었는지를 말한다 — 조건 번호로 고른 고정 문장이 아니다', () => {
    const copy = describeNotification(facts({
      schedule: { dayNo: 2, startTime: '14:00' },
      changes: [{ label: '운영시간', before: '09:00~18:00', after: '09:00~17:00' }],
    }));
    expect(copy.what).toBe('운영시간 정보가 바뀌었습니다.');
    expect(copy.impact).toBe('2일차 14:00 일정입니다.');
  });

  it('여러 가지가 바뀌면 다 적는다', () => {
    const copy = describeNotification(facts({
      changes: [
        { label: '휴무일', before: '월', after: '월·화' },
        { label: '운영시간', before: '09:00~18:00', after: '09:00~17:00' },
      ],
    }));
    expect(copy.what).toBe('휴무일 · 운영시간 정보가 바뀌었습니다.');
  });

  it('🔴 견줄 이전 검수가 없으면 그렇게 말한다 — 바뀐 것을 지어내지 않는다 (FR-RU-051)', () => {
    const copy = describeNotification(facts({ hasBefore: false }));
    expect(copy.what).toContain('이전 검수 기록이 없습니다');
    expect(copy.what).not.toContain('바뀌었습니다');
  });

  it('아직 다시 검수 전이면 다시 검수해야 보인다고 말한다', () => {
    expect(describeNotification(facts({ hasAfter: false })).what).toContain('다시 검수하면');
  });

  it('휴무일 · 운영시간은 그대로인데 지문이 달랐으면 그렇게 말한다', () => {
    expect(describeNotification(facts()).what).toContain('그대로이고 그 밖의 판정 정보');
  });

  it('🔴 행사는 기간과 겹치는 일차를 말한다', () => {
    const copy = describeNotification(facts({
      condition: 3, eventPeriod: { start: '2026-10-30', end: '2026-11-01' }, overlapDays: [1, 2],
    }));
    expect(copy.what).toBe('행사 기간은 10월 30일 ~ 11월 1일입니다. 여행 1 · 2일차와 겹칩니다.');
    expect(copy.impact).toContain('일정에 든 행사는 아닙니다');
  });

  it('하루짜리 행사는 행사일로 적고, 일정에 든 행사면 그 줄을 가리킨다', () => {
    const copy = describeNotification(facts({
      condition: 3, eventPeriod: { start: '2026-10-31', end: '2026-10-31' }, overlapDays: [1],
      schedule: { dayNo: 1, startTime: '19:00' },
    }));
    expect(copy.what).toBe('행사일은 10월 31일입니다. 여행 1일차와 겹칩니다.');
    expect(copy.impact).toBe('1일차 19:00 일정에 든 행사입니다.');
  });

  it('기간을 남기기 전에 만들어진 행사 알림은 기간을 지어내지 않는다', () => {
    expect(describeNotification(facts({ condition: 3 })).what).toBe('여행일과 겹치는 행사의 관광정보가 수정됐습니다.');
  });

  it('조건 2 는 일정에 든 곳이 아니라는 것과 왜 알리는지를 말한다', () => {
    const copy = describeNotification(facts({ condition: 2 }));
    expect(copy.impact).toContain('일정에 든 곳은 아닙니다');
    expect(copy.impact).toContain('출발일이 가까워');
  });

  it('🔴 사실이 다른 카드 넷은 문장이 서로 다르다 — 2026-09-21 운영에서는 넷이 같았다', () => {
    const cards = [
      facts({ schedule: { dayNo: 1, startTime: '12:50' }, hasBefore: false }),
      facts({ condition: 3, eventPeriod: { start: '2026-10-31', end: '2026-10-31' }, overlapDays: [1], schedule: { dayNo: 1, startTime: '19:00' } }),
      facts({ schedule: { dayNo: 1, startTime: '15:20' }, changes: [{ label: '운영시간', before: '10:00~17:00', after: '10:00~16:00' }] }),
      facts({ schedule: { dayNo: 2, startTime: '16:00' }, changes: [{ label: '휴무일', before: '없음', after: '월' }] }),
    ].map((f) => { const c = describeNotification(f); return `${c.what}|${c.impact}`; });
    expect(new Set(cards).size).toBe(4);
  });

  it('표출 중단과 새 소식은 원래 문장을 그대로 쓴다', () => {
    expect(describeNotification(facts({ hidden: true })).what).toContain('표출이 중단');
    expect(describeNotification(facts({ condition: 4 })).what).toContain('이 상품에 없는 유형');
  });
});

describe('날짜', () => {
  it('겹치는 여행 일차를 센다', () => {
    expect(overlapDays('2026-10-31', 1, { start: '2026-10-31', end: '2026-10-31' })).toEqual([1]);
    expect(overlapDays('2026-11-07', 2, { start: '2026-11-08', end: '2026-11-30' })).toEqual([2, 3]);
    expect(overlapDays('2026-11-07', 2, { start: '2026-12-01', end: '2026-12-02' })).toEqual([]);
    expect(overlapDays('2026-11-07', null, { start: '2026-11-07', end: '2026-11-07' })).toEqual([]);
    expect(overlapDays('2026-11-07', 1, null)).toEqual([]);
  });

  it('달을 넘는 여행도 센다', () => {
    expect(overlapDays('2026-10-31', 2, { start: '2026-11-01', end: '2026-11-02' })).toEqual([2, 3]);
  });

  it('공사 수정 시각에서 날짜만 읽는다', () => {
    expect(modifiedOn('20260918143012')).toBe('2026-09-18');
    expect(modifiedOn('')).toBeNull();
    expect(modifiedOn(undefined)).toBeNull();
    expect(koreanDay('2026-09-08')).toBe('9월 8일');
  });
});
