import { DAYS_OF_WEEK, type DayOfWeek, type MonthDay, type TimeOfDay } from './types';

/**
 * 시각 · 요일 · 월일 원시 표기를 스키마 표기로 옮긴다 (DR-NM-003).
 *
 * 실측 원문의 표기 흔들림을 여기서 전부 흡수한다 — `9:00` · `09:00` · `17시` · `24:00` ·
 * `월` · `월요일` · `평일` · `1월1일` · `1월 1일`.
 */

/** `HH:mm`. 하루 끝은 `24:00` — 실측 원문에 `00:00~24:00` 이 있다 */
const TIME_RE = /^(\d{1,2})\s*(?::\s*(\d{2})|시(?:\s*(\d{1,2})\s*분)?)$/;

/**
 * 시각 하나를 `HH:mm` 으로 정규화한다. 해석 못 하면 `null`.
 *
 * `18:0` 처럼 잘린 값은 **추측하지 않고 실패시킨다** — `18:00` 인지 `18:05` 인지 알 수 없다.
 * (실측: 강릉 자료실 원문에 `09:00~18:0` 이 있다)
 */
export function parseTimeOfDay(raw: string): TimeOfDay | null {
  const m = TIME_RE.exec(raw.trim());
  if (m === null) return null;

  const hour = Number(m[1]);
  const minute = m[2] !== undefined ? Number(m[2]) : m[3] !== undefined ? Number(m[3]) : 0;
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (minute > 59) return null;
  // 24:00 은 하루 끝을 뜻하는 관용 표기라 허용하고, 24:30 같은 값은 막는다
  if (hour > 24 || (hour === 24 && minute !== 0)) return null;

  return `${pad2(hour)}:${pad2(minute)}`;
}

/** `close` 가 `open` 보다 이르면 익일 종료(심야 영업)다 (DR-NM-023) */
export function isOvernight(open: TimeOfDay, close: TimeOfDay): boolean {
  return toMinutes(close) < toMinutes(open);
}

export function toMinutes(time: TimeOfDay): number {
  const [h, m] = time.split(':');
  return Number(h) * 60 + Number(m);
}

// ── 요일 ──────────────────────────────────────────────────────────────

const DAY_BY_KOREAN: ReadonlyMap<string, DayOfWeek> = new Map([
  ['월', 'MON'], ['화', 'TUE'], ['수', 'WED'], ['목', 'THU'],
  ['금', 'FRI'], ['토', 'SAT'], ['일', 'SUN'],
]);

/** `평일` · `주말` 처럼 여러 요일을 한 단어로 가리키는 표현 */
const DAY_GROUPS: ReadonlyMap<string, readonly DayOfWeek[]> = new Map([
  ['평일', ['MON', 'TUE', 'WED', 'THU', 'FRI']],
  ['주중', ['MON', 'TUE', 'WED', 'THU', 'FRI']],
  ['주말', ['SAT', 'SUN']],
]);

/** `월요일` · `월` · `월요` 어느 쪽이든 받는다 */
export function parseDay(raw: string): DayOfWeek | null {
  const m = /^([월화수목금토일])(?:요일?)?$/.exec(raw.trim());
  return m === null ? null : (DAY_BY_KOREAN.get(m[1] as string) ?? null);
}

/**
 * 요일 표현 하나를 요일 집합으로 편다.
 *
 *   `월요일`          → [MON]
 *   `월요일~금요일`    → [MON,TUE,WED,THU,FRI]   (월 시작 주 순서로 잇는다)
 *   `일요일~목요일`    → [SUN,MON,TUE,WED,THU]   (주를 넘겨 잇는다)
 *   `평일`            → [MON..FRI]
 *   `평일/일요일`      → [MON..FRI,SUN]
 */
export function parseDaySet(raw: string): readonly DayOfWeek[] | null {
  const text = raw.trim();
  if (text === '') return null;

  const parts = text.split(/\s*[/,·]\s*/).filter((p) => p !== '');
  if (parts.length > 1) {
    const merged: DayOfWeek[] = [];
    for (const part of parts) {
      const days = parseDaySet(part);
      if (days === null) return null;
      for (const d of days) if (!merged.includes(d)) merged.push(d);
    }
    return merged;
  }

  const group = DAY_GROUPS.get(text);
  if (group !== undefined) return group;

  const range = /^([월화수목금토일])(?:요일?)?\s*[~-]\s*([월화수목금토일])(?:요일?)?$/.exec(text);
  if (range !== null) {
    const from = DAY_BY_KOREAN.get(range[1] as string);
    const to = DAY_BY_KOREAN.get(range[2] as string);
    if (from === undefined || to === undefined) return null;
    return expandDayRange(from, to);
  }

  const single = parseDay(text);
  return single === null ? null : [single];
}

/** `일~목` 처럼 주를 넘기는 범위도 편다. `월~월` 은 하루로 본다 */
export function expandDayRange(from: DayOfWeek, to: DayOfWeek): readonly DayOfWeek[] {
  const start = DAYS_OF_WEEK.indexOf(from);
  const end = DAYS_OF_WEEK.indexOf(to);
  const out: DayOfWeek[] = [];
  for (let i = 0; i < DAYS_OF_WEEK.length; i++) {
    const idx = (start + i) % DAYS_OF_WEEK.length;
    out.push(DAYS_OF_WEEK[idx] as DayOfWeek);
    if (idx === end) break;
  }
  return out;
}

/** 스키마 표기 순서(월~일)로 정렬하고 중복을 없앤다 — 병합 결과가 입력 순서에 흔들리지 않게 */
export function sortDays(days: Iterable<DayOfWeek>): readonly DayOfWeek[] {
  return DAYS_OF_WEEK.filter((d) => [...days].includes(d));
}

// ── 월일 ──────────────────────────────────────────────────────────────

/** `1월 1일` · `1월1일` · `12월 25일` → `MM-DD` */
export function parseMonthDay(raw: string): MonthDay | null {
  const m = /^(\d{1,2})\s*월\s*(\d{1,2})\s*일$/.exec(raw.trim());
  if (m === null) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${pad2(month)}-${pad2(day)}`;
}

/** `3월~10월` → `03-01` ~ `10-31`. 계절 운영 구간용 */
export function parseMonthRange(raw: string): { from: MonthDay; to: MonthDay } | null {
  const m = /^(\d{1,2})\s*월\s*[~-]\s*(\d{1,2})\s*월$/.exec(raw.trim().replace(/\s+/g, ' '));
  if (m === null) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (from < 1 || from > 12 || to < 1 || to > 12) return null;
  return { from: `${pad2(from)}-01`, to: `${pad2(to)}-${pad2(lastDayOfMonth(to))}` };
}

/** 윤년을 가정하지 않는다 — 2월은 28일로 둔다. 계절 구간 경계라 하루 차이가 판정을 바꾸지 않는다 */
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
function lastDayOfMonth(month: number): number {
  return MONTH_LENGTHS[month - 1] ?? 31;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
