import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addDays, dayOfWeek, formatIsoDate, parseIsoDate } from '../engine/calendar/dates';
import { KOREAN_HOLIDAYS } from '../engine/calendar/holidays';
import { DEMO_PRODUCTS } from './demo-products';

/**
 * 시연 시드의 **출발일**을 지킨다. 회귀 픽스처 쪽은 `engine/rules/fixture-dates.spec.ts` 다.
 *
 * 시드는 픽스처에서 뽑았지만 출발일만 다르다 — 픽스처 날짜는 엔진 테스트 입력이라 옮길
 * 이유가 없고, 시드 날짜는 심사 · 시연 기간보다 미래여야 한다. 지나면 R08 이 미래 운행
 * 정보 대신 「현재 시각 기준」 폴백으로 내려가고(EI-KM-002) R09 가 예보 범위를 벗어난다
 * (FR-RU-091). 검수 결과가 조용히 달라지는데 그걸 아무것도 막지 않고 있었다 (이슈 #429).
 */

/**
 * 심사 · 시연이 끝나는 날 — 시상식 2026-11-05. 1차 기능심사는 「10월 중」, 합격 발표 10.21,
 * 최종 PT 10.28 이다. 출발일이 이 뒤여야 심사 기간 전체에서 미래 일정으로 보인다.
 *
 * **「오늘보다 미래」로는 부족하다.** 10-08 출발도 9월에는 미래라 그 검사를 통과하는데,
 * PT 날에는 과거다. 그래서 오늘이 아니라 이 날을 기준으로 본다.
 */
const JUDGING_ENDS = '2026-11-05';

const PRODUCTS = join(__dirname, '../../../../fixtures/products');
const FIXTURES = ['TP-01_standard.json', 'TP-02_boundary.json', 'TP-03_violation.json', 'TP-04_failure.json'];

interface Fixture {
  readonly product: { readonly name: string; readonly startDate: string };
}

/** 픽스처 상품명 → 출발일. 시드와 픽스처는 상품명으로 이어진다 */
const fixtureStart = new Map<string, string>(
  FIXTURES.map((file) => {
    const f = JSON.parse(readFileSync(join(PRODUCTS, file), 'utf8')) as Fixture;
    return [f.product.name, f.product.startDate] as const;
  }),
);

function date(iso: string) {
  const d = parseIsoDate(iso);
  if (d === null) throw new Error(`출발일이 잘못됐다: ${iso}`);
  return d;
}

function visitDates(startDate: string, nights: number): string[] {
  const start = date(startDate);
  return Array.from({ length: nights + 1 }, (_, i) => formatIsoDate(addDays(start, i)));
}

const cases = DEMO_PRODUCTS.map((p) => [p.name, p] as const);

describe('시연 시드 출발일', () => {
  it.each(cases)('🔴 심사 · 시연이 끝나는 날보다 뒤다 — %s', (_name, product) => {
    expect(
      product.startDate > JUDGING_ENDS,
      `${product.startDate} 은 시상식(${JUDGING_ENDS}) 전이다 — 심사 중에 과거가 된다`,
    ).toBe(true);
  });

  it.each(cases)('🔴 오늘보다 미래다 — %s', (_name, product) => {
    /*
     * **이 검사는 시간이 지나면 빨개진다. 그게 목적이다.** 시연 데이터가 과거가 된 것을
     * 보는 사람보다 먼저 알아야 한다. 빨개지면 출발일을 7의 배수만큼 뒤로 옮기고
     * `JUDGING_ENDS` 도 그때의 기준일로 고친다.
     */
    const today = formatIsoDate(nowKst());
    expect(product.startDate > today, `${product.startDate} 이 지났다 — 7의 배수로 옮길 것`).toBe(true);
  });

  it.each(cases)('🔴 요일이 대응 픽스처와 같다 — %s', (_name, product) => {
    /*
     * 요일이 바뀌면 기대 판정이 깨진다 — 가람집옹심이 `매주 화요일` 휴무가 감성 상품의
     * 명세 AC(29점)를 만드는 차단 하나이고, 한복 문화 창작소 `매주 토요일~일요일`이
     * 역사·힐링 상품의 「차단 0건」을 가른다. 그래서 7의 배수로만 옮긴다.
     */
    const origin = fixtureStart.get(product.name);
    expect(origin, `${product.name} 에 대응하는 픽스처가 없다`).toBeDefined();
    expect(dayOfWeek(date(product.startDate))).toBe(dayOfWeek(date(origin as string)));
  });

  it.each(cases)('🔴 방문일에 법정공휴일이 없다 — %s', (_name, product) => {
    /*
     * TP-01 이 원래 10-08 출발이었는데 2일차가 10-09 한글날에 걸려, 휴무 원문에
     * `법정공휴일` 이 든 한복 문화 창작소가 차단으로 잡혔다. 「출시 가능」 시연이 조용히
     * 깨져 있었다. 옮긴 주에 공휴일이 끼면 같은 일이 난다.
     */
    for (const iso of visitDates(product.startDate, product.nights)) {
      const d = date(iso);
      expect(KOREAN_HOLIDAYS.isSupportedYear(d.year), `${iso} 가 공휴일 표 밖이다`).toBe(true);
      expect(
        KOREAN_HOLIDAYS.matches('LEGAL_HOLIDAY', d),
        `${iso} 가 ${KOREAN_HOLIDAYS.nameOf(d) ?? '공휴일'} 이다`,
      ).toBe(false);
    }
  });
});

/** 오늘(KST). 테스트가 도는 곳의 시간대에 기대지 않는다 */
function nowKst() {
  const [y, m, d] = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).split('-');
  return { year: Number(y), month: Number(m), day: Number(d) };
}
