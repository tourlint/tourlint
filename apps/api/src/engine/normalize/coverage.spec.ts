import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PARSER_COVERAGE } from '@tourlint/shared';
import { parseOperatingInfo } from './parse';
import type { NormalizedOperatingInfo } from './types';

/**
 * 실측 커버리지 하네스 (FR-AU-004 v1.7 · DR-TD-003).
 *
 * 정답셋은 `fixtures/operating_info.csv` 287건이다. **BOM 이 있으므로 앞 3바이트를 걷어낸다.**
 *
 * 커버리지 = 해석 성공 ÷ (전체 − 결측). **결측은 분모에서 제외한다** — 결측은 해석 실패가
 * 아니라 정상 산출물이기 때문이다(EX-PS 도입부). 포함하면 휴무일 최대 83.3% 라
 * 90% 달성이 수학적으로 불가능하다.
 *
 * 실패 목록은 스크래치 파일이 아니라 **단언 메시지**에 남긴다 — 커버리지가 내려가면
 * 무엇이 깨졌는지 그 자리에서 보여야 한다.
 */

const CSV = join(__dirname, '../../../../../fixtures/operating_info.csv');

/** R01 이 휴무 판정에 읽는 경로 */
const CLOSED_PATHS = ['alwaysOpen', 'weeklyClosed', 'nthWeekday', 'fixedClosed', 'holidayRule'] as const;
/**
 * 운영시간 필드를 해석해 얻을 수 있는 경로.
 *
 * `checkIn` · `checkOut` 이 함께 있는 이유 — 레포츠(28) 4건은 운영시간 필드에 입실 · 퇴실이
 * 담겨 온다(DR-NM-026 실측). 이때 `openHours` 가 비는 것은 **해석 실패가 아니라 정답**이다.
 * 운영시간으로 읽었다면 오히려 심야 영업으로 오판했을 것이다.
 */
const HOURS_PATHS = ['openHours', 'dayOfWeekHours', 'seasonalHours', 'checkIn', 'checkOut'] as const;

interface Row {
  readonly contentid: string;
  readonly title: string;
  readonly contentTypeId: number;
  readonly restField: string;
  readonly restRaw: string;
  readonly useField: string;
  readonly useRaw: string;
}

function loadRows(): readonly Row[] {
  const text = readFileSync(CSV, 'utf8').replace(/^\uFEFF/, '');
  const records = parseCsv(text);
  const header = records[0] ?? [];
  const col = (name: string): number => header.indexOf(name);
  const [id, title, ctid, restF, rest, useF, use] = [
    col('contentid'), col('title'), col('contenttypeid'),
    col('rest_field'), col('rest_raw'), col('use_field'), col('use_raw'),
  ] as const;

  return records.slice(1)
    .filter((r) => r.length > 1)
    .map((r) => ({
      contentid: r[id] ?? '',
      title: r[title] ?? '',
      contentTypeId: Number(r[ctid] ?? '0'),
      restField: r[restF] ?? '',
      restRaw: r[rest] ?? '',
      useField: r[useF] ?? '',
      useRaw: r[use] ?? '',
    }));
}

/** 정답셋이 CRLF·따옴표 안 개행을 포함하므로 직접 판다 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

interface Measurement {
  readonly total: number;
  readonly missing: number;
  readonly denominator: number;
  readonly passing: number;
  readonly ratio: number;
  readonly failures: readonly { readonly title: string; readonly raw: string }[];
}

/**
 * **진짜 진입점으로 잰다.** 하위 파서만 재면 신뢰도 강등을 놓쳐 실제보다 후하게 나온다 —
 * `06:00~23:00 ※ 점포별 상이함` 은 시각을 읽었어도 판정에 쓸 수 없다.
 */
function normalize(row: Row): NormalizedOperatingInfo {
  return parseOperatingInfo({
    contentTypeId: row.contentTypeId as 12,
    raw: { [row.restField]: row.restRaw, [row.useField]: row.useRaw },
  });
}

/** 축의 어느 경로든 판정에 쓸 수 있으면(확정 · 추정) 해석 성공이다 */
function axisUsable(out: NormalizedOperatingInfo, paths: readonly string[]): boolean {
  return paths.some((p) => {
    const c = out.confidence.byPath[p];
    return c === 'CONFIRMED' || c === 'ESTIMATED';
  });
}

function measure(rows: readonly Row[], pick: (r: Row) => string, ok: (row: Row) => boolean): Measurement {
  const values = rows.map((r) => ({ row: r, title: r.title, raw: pick(r).trim() }));
  const present = values.filter((v) => v.raw !== '');
  const failures = present.filter((v) => !ok(v.row));
  const passing = present.length - failures.length;

  return {
    total: values.length,
    missing: values.length - present.length,
    denominator: present.length,
    passing,
    ratio: present.length === 0 ? 0 : passing / present.length,
    failures,
  };
}

/** 실패 표본을 단언 메시지에 싣는다. 전부 싣지 않는 건 출력이 잘리기 때문이다 */
function report(label: string, m: Measurement, target: number): string {
  const head =
    `${label} — ${m.passing}/${m.denominator} (${(m.ratio * 100).toFixed(1)}%) · 목표 ${target}건 · 결측 ${m.missing}\n` +
    `미해석 ${m.failures.length}건:\n`;
  return head + m.failures.slice(0, 40).map((f) => `  · ${f.raw.slice(0, 100)}`).join('\n');
}

describe('운영정보 해석기 실측 커버리지', () => {
  const rows = loadRows();

  it('정답셋을 읽는다 — 287건 · 강릉 170 / 속초 117', () => {
    expect(rows).toHaveLength(PARSER_COVERAGE.total);
  });

  it('휴무일 해석 — 216/239 이상 (90%)', () => {
    const m = measure(rows, (r) => r.restRaw, (r) => axisUsable(normalize(r), CLOSED_PATHS));

    expect(m.missing, '결측 건수가 기준선과 다르다').toBe(PARSER_COVERAGE.restDay.missing);
    expect(m.denominator).toBe(PARSER_COVERAGE.restDay.denominator);
    // 실패 목록을 메시지로 남긴다 — 숫자만 보면 무엇이 깨졌는지 모른다
    expect(m.passing, report('휴무일', m, PARSER_COVERAGE.restDay.passing))
      .toBeGreaterThanOrEqual(PARSER_COVERAGE.restDay.passing);
  });

  it('운영시간 해석 — 240/266 이상 (90%)', () => {
    const m = measure(rows, (r) => r.useRaw, (r) => axisUsable(normalize(r), HOURS_PATHS));

    expect(m.missing, '결측 건수가 기준선과 다르다').toBe(PARSER_COVERAGE.openHours.missing);
    expect(m.denominator).toBe(PARSER_COVERAGE.openHours.denominator);
    expect(m.passing, report('운영시간', m, PARSER_COVERAGE.openHours.passing))
      .toBeGreaterThanOrEqual(PARSER_COVERAGE.openHours.passing);
  });
});

// 개발 중 실패 원문을 통째로 보려면 이 파일을 그대로 두고 REPORT_PATH 를 지정해 실행한다
const REPORT_PATH = process.env.PARSER_COVERAGE_REPORT;
if (REPORT_PATH !== undefined) {
  describe('커버리지 보고서 파일', () => {
    it('기록한다', () => {
      const rows = loadRows();
      const rest = measure(rows, (r) => r.restRaw, (r) => axisUsable(normalize(r), CLOSED_PATHS));
      const hours = measure(rows, (r) => r.useRaw, (r) => axisUsable(normalize(r), HOURS_PATHS));
      writeFileSync(
        REPORT_PATH,
        [report('휴무일', rest, PARSER_COVERAGE.restDay.passing),
         '', '전체 미해석(휴무):', ...rest.failures.map((f) => `  ${f.title} | ${f.raw}`),
         '', report('운영시간', hours, PARSER_COVERAGE.openHours.passing),
         '', '전체 미해석(운영):', ...hours.failures.map((f) => `  ${f.title} | ${f.raw}`)].join('\n'),
        'utf8',
      );
      expect(true).toBe(true);
    });
  });
}
