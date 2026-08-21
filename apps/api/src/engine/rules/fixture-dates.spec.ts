import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addDays, dayOfWeek, formatIsoDate, parseIsoDate } from '../calendar/dates';
import { KOREAN_HOLIDAYS } from '../calendar/holidays';

/**
 * 회귀 픽스처의 **날짜**를 지킨다.
 *
 * 픽스처는 출발일만 갖고 각 항목의 방문일은 `출발일 + (dayNo − 1)` 로 산출된다.
 * 그래서 출발일 하나를 바꾸면 12곳의 요일과 공휴일 해당 여부가 전부 달라진다.
 *
 * 실제로 그런 일이 있었다 — TP-01 이 원래 10-08 출발이었고 2일차가 **10-09 한글날**에
 * 걸려, 휴무 원문에 `법정공휴일` 이 든 관광지 한 곳이 차단으로 잡혔다. "차단 0건" 이라는
 * 픽스처의 목적이 조용히 깨져 있었다. 이 테스트는 그 재발을 막는다.
 */

const PRODUCTS = join(__dirname, '../../../../../fixtures/products');

interface Fixture {
  readonly fixtureId: string;
  readonly product: { readonly startDate: string; readonly nights: number };
  readonly items: readonly { readonly dayNo: number; readonly placeLabel: string }[];
}

function load(file: string): Fixture {
  return JSON.parse(readFileSync(join(PRODUCTS, file), 'utf8')) as Fixture;
}

function itineraryDates(f: Fixture): { dayNo: number; date: string }[] {
  const start = parseIsoDate(f.product.startDate);
  if (start === null) throw new Error(`${f.fixtureId}: 출발일이 잘못됐다`);
  return Array.from({ length: f.product.nights + 1 }, (_, i) => ({
    dayNo: i + 1,
    date: formatIsoDate(addDays(start, i)),
  }));
}

describe('회귀 픽스처 날짜', () => {
  it('TP-01 은 어느 일차도 법정공휴일에 걸리지 않는다', () => {
    // 이 픽스처의 목적은 "차단 0건인 정상 경로" 다. 공휴일이 끼면 목적이 깨진다
    const f = load('TP-01_standard.json');
    for (const { dayNo, date } of itineraryDates(f)) {
      const d = parseIsoDate(date);
      expect(d).not.toBeNull();
      expect(
        KOREAN_HOLIDAYS.matches('LEGAL_HOLIDAY', d as NonNullable<typeof d>),
        `${dayNo}일차 ${date} 가 ${KOREAN_HOLIDAYS.nameOf(d as NonNullable<typeof d>) ?? '공휴일'} 이다`,
      ).toBe(false);
    }
  });

  it('TP-01 은 2026-10-22(목) 출발 · 10/22 목 · 10/23 금 · 10/24 토', () => {
    const f = load('TP-01_standard.json');
    expect(f.product.startDate).toBe('2026-10-22');
    expect(itineraryDates(f).map((x) => x.date)).toEqual(['2026-10-22', '2026-10-23', '2026-10-24']);
  });

  it.each([
    ['TP-01_standard.json', ['THU', 'FRI', 'SAT']],
    ['TP-02_boundary.json', ['THU', 'FRI', 'SAT']],
    ['TP-03_violation.json', ['TUE', 'WED']],
  ])('%s 의 요일이 기대값 표와 일치한다', (file, expected) => {
    const f = load(file);
    const days = itineraryDates(f).map(({ date }) => dayOfWeek(parseIsoDate(date) as NonNullable<ReturnType<typeof parseIsoDate>>));
    expect(days).toEqual(expected);
  });

  it('TP-03 은 1일차가 화요일이어야 한다 — 가람집 `매주 화요일` 차단의 전제다', () => {
    const f = load('TP-03_violation.json');
    const first = itineraryDates(f)[0];
    expect(first?.date).toBe('2026-10-13');
    expect(dayOfWeek(parseIsoDate(first?.date ?? '') as NonNullable<ReturnType<typeof parseIsoDate>>)).toBe('TUE');
  });

  it('모든 픽스처의 방문일이 공휴일 표가 덮는 연도 안에 있다', () => {
    for (const file of ['TP-01_standard.json', 'TP-02_boundary.json', 'TP-03_violation.json']) {
      for (const { date } of itineraryDates(load(file))) {
        const d = parseIsoDate(date) as NonNullable<ReturnType<typeof parseIsoDate>>;
        expect(KOREAN_HOLIDAYS.isSupportedYear(d.year), `${file} ${date}`).toBe(true);
      }
    }
  });
});
