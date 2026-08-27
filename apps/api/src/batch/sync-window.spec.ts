import { describe, expect, it } from 'vitest';
import { MAX_DAYS_PER_RUN, isWeekend, kstDayOfWeek, kstToday, pendingDates, toKtoDate } from './sync-window';

/** 한국 시간 문자열을 Date 로. 서버 시간대에 흔들리지 않게 한다 */
const kst = (iso: string): Date => new Date(`${iso}+09:00`);

describe('배치 날짜 창 (FR-MO-010 · 011 · 015)', () => {
  it('직전 성공일 다음 날부터 어제까지', () => {
    // 2026-08-27(목) 05:00 실행 · 마지막 처리 08-23
    expect(pendingDates('2026-08-23', kst('2026-08-27T05:00:00')))
      .toEqual(['2026-08-24', '2026-08-25', '2026-08-26']);
  });

  it('🔴 오늘은 넣지 않는다 — 공사가 하루 종일 갱신한다', () => {
    /*
     * 지금 부르면 오늘 분이 덜 찬 채로 온다. 처리한 것으로 치면 나머지를 영영 못 본다
     * (EI-KT-011 실측: 같은 일자가 새벽 11건 · 오후 177건).
     */
    const dates = pendingDates('2026-08-25', kst('2026-08-27T05:00:00'));
    expect(dates).toEqual(['2026-08-26']);
    expect(dates).not.toContain('2026-08-27');
  });

  it('어제까지 다 처리했으면 볼 것이 없다', () => {
    expect(pendingDates('2026-08-26', kst('2026-08-27T05:00:00'))).toEqual([]);
  });

  it('오늘까지 처리된 상태여도 앞으로 가지 않는다', () => {
    expect(pendingDates('2026-08-27', kst('2026-08-27T05:00:00'))).toEqual([]);
  });

  it('🔴 한 번도 안 돌았으면 어제 하루만 본다', () => {
    // 시작점이 없다고 과거를 통째로 훑으면 예산이 남지 않는다
    expect(pendingDates(null, kst('2026-08-27T05:00:00'))).toEqual(['2026-08-26']);
  });

  it('🔴 밀린 날짜가 많아도 한 번에 도는 수를 제한한다', () => {
    const dates = pendingDates('2026-01-01', kst('2026-08-27T05:00:00'));
    expect(dates).toHaveLength(MAX_DAYS_PER_RUN);
    expect(dates[0]).toBe('2026-01-02');
    // 나머지는 다음 배치가 이어 받는다 — last_covered 가 처리한 데까지만 올라간다
    expect(dates[dates.length - 1]).toBe('2026-01-15');
  });

  it('월말·연말을 넘어간다', () => {
    expect(pendingDates('2026-02-27', kst('2026-03-02T05:00:00')))
      .toEqual(['2026-02-28', '2026-03-01']);
    expect(pendingDates('2025-12-30', kst('2026-01-02T05:00:00')))
      .toEqual(['2025-12-31', '2026-01-01']);
  });

  it('윤년 2월 29일을 건너뛰지 않는다', () => {
    // 2028 은 윤년이다
    expect(pendingDates('2028-02-27', kst('2028-03-01T05:00:00')))
      .toEqual(['2028-02-28', '2028-02-29']);
  });
});

describe('주말 · 시간대', () => {
  it('토·일에는 돌지 않는다 (FR-MO-010)', () => {
    expect(isWeekend(kst('2026-08-29T05:00:00'))).toBe(true); // 토
    expect(isWeekend(kst('2026-08-30T05:00:00'))).toBe(true); // 일
    expect(isWeekend(kst('2026-08-31T05:00:00'))).toBe(false); // 월
  });

  it('🔴 한국 시간 기준이다 — UTC 로 세면 하루가 밀린다', () => {
    // 한국 2026-08-31(월) 05:00 = UTC 08-30(일) 20:00
    const mondayDawn = kst('2026-08-31T05:00:00');
    expect(mondayDawn.getUTCDay()).toBe(0); // UTC 로는 일요일
    expect(kstDayOfWeek(mondayDawn)).toBe(1); // 한국으로는 월요일
    expect(isWeekend(mondayDawn)).toBe(false);
  });

  it('🔴 자정 근처 날짜가 밀리지 않는다', () => {
    // 한국 2026-08-27 00:30 = UTC 08-26 15:30
    expect(kstToday(kst('2026-08-27T00:30:00'))).toBe('2026-08-27');
    // 한국 2026-08-27 23:30 = UTC 08-27 14:30
    expect(kstToday(kst('2026-08-27T23:30:00'))).toBe('2026-08-27');
  });
});

describe('공사 날짜 형식', () => {
  it('YYYYMMDD 로 바꾼다', () => {
    expect(toKtoDate('2026-08-26')).toBe('20260826');
  });
});
