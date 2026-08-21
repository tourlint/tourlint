import { describe, expect, it } from 'vitest';
import {
  expandDayRange, isOvernight, parseDay, parseDaySet, parseMonthDay, parseMonthRange,
  parseTimeOfDay, sortDays, toMinutes,
} from './primitives';

describe('parseTimeOfDay — 표기 흔들림을 흡수한다 (DR-NM-003)', () => {
  it.each([
    ['09:00', '09:00'], ['9:00', '09:00'], ['5:00', '05:00'],
    ['09:00 ', '09:00'], ['10 : 30', '10:30'],
    ['17시', '17:00'], ['17시 30분', '17:30'],
    ['00:00', '00:00'],
  ])('%s → %s', (raw, expected) => {
    expect(parseTimeOfDay(raw)).toBe(expected);
  });

  it('24:00 은 하루 끝으로 받는다 — 실측 원문에 `00:00~24:00` 이 있다', () => {
    expect(parseTimeOfDay('24:00')).toBe('24:00');
  });

  it.each(['24:30', '25:00', '09:70', '', 'abc', '18:0'])('%s 는 해석하지 않는다', (raw) => {
    expect(parseTimeOfDay(raw)).toBeNull();
  });

  it('잘린 값을 추측하지 않는다 — `18:0` 이 18:00 인지 18:05 인지 알 수 없다', () => {
    // 실측: 강릉 자료실 원문에 `09:00~18:0` 이 있다
    expect(parseTimeOfDay('18:0')).toBeNull();
  });
});

describe('isOvernight — 심야 영업 (DR-NM-023)', () => {
  it('close 가 open 보다 이르면 익일 종료다', () => {
    expect(isOvernight('18:00', '02:00')).toBe(true);
    expect(isOvernight('09:00', '18:00')).toBe(false);
    expect(isOvernight('00:00', '24:00')).toBe(false);
  });

  it('toMinutes 는 24:00 을 하루 끝으로 센다', () => {
    expect(toMinutes('24:00')).toBe(1440);
    expect(toMinutes('00:00')).toBe(0);
  });
});

describe('parseDaySet', () => {
  it.each([
    ['월요일', ['MON']], ['월', ['MON']], ['토요일', ['SAT']],
    ['평일', ['MON', 'TUE', 'WED', 'THU', 'FRI']],
    ['주말', ['SAT', 'SUN']],
  ])('%s → %s', (raw, expected) => {
    expect(parseDaySet(raw)).toEqual(expected);
  });

  it('요일 범위를 편다', () => {
    expect(parseDaySet('수요일~일요일')).toEqual(['WED', 'THU', 'FRI', 'SAT', 'SUN']);
    expect(parseDaySet('월요일~토요일')).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);
  });

  it('주를 넘기는 범위도 편다 — `일~목` 은 일월화수목이다', () => {
    expect(parseDaySet('일~목')).toEqual(['SUN', 'MON', 'TUE', 'WED', 'THU']);
    expect(parseDaySet('금~수')).toEqual(['FRI', 'SAT', 'SUN', 'MON', 'TUE', 'WED']);
  });

  it('나열을 합치고 중복을 없앤다', () => {
    expect(parseDaySet('평일/일요일')).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SUN']);
    expect(parseDaySet('토요일, 일요일')).toEqual(['SAT', 'SUN']);
  });

  it('요일이 아니면 null 이다', () => {
    expect(parseDaySet('점포별 상이함')).toBeNull();
    expect(parseDaySet('')).toBeNull();
  });

  it('같은 요일 범위는 하루로 본다', () => {
    expect(expandDayRange('MON', 'MON')).toEqual(['MON']);
  });

  it('sortDays 는 언제나 월~일 순이다 — 병합 결과가 입력 순서에 흔들리면 안 된다', () => {
    expect(sortDays(['SUN', 'WED', 'MON'])).toEqual(['MON', 'WED', 'SUN']);
    expect(sortDays(['SAT', 'SAT'])).toEqual(['SAT']);
  });

  it('parseDay 는 단일 요일만 받는다', () => {
    expect(parseDay('화요일')).toBe('TUE');
    expect(parseDay('월~금')).toBeNull();
  });
});

describe('월일 · 월 범위', () => {
  it.each([['1월 1일', '01-01'], ['1월1일', '01-01'], ['12월 25일', '12-25']])('%s → %s', (raw, e) => {
    expect(parseMonthDay(raw)).toBe(e);
  });

  it.each(['13월 1일', '1월 32일', '설날'])('%s 는 해석하지 않는다', (raw) => {
    expect(parseMonthDay(raw)).toBeNull();
  });

  it('월 범위는 달의 첫날~마지막날이다', () => {
    expect(parseMonthRange('3월~10월')).toEqual({ from: '03-01', to: '10-31' });
    expect(parseMonthRange('11월~2월')).toEqual({ from: '11-01', to: '02-28' });
  });

  it('공사 원문의 `3 월~10 월` 처럼 공백이 끼어도 읽는다', () => {
    expect(parseMonthRange('3 월~10 월')).toEqual({ from: '03-01', to: '10-31' });
  });
});
