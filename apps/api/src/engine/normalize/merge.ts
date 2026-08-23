import type { ParseConfidence } from '@tourlint/shared';
import type { ClosedHit } from './closed';
import type { HoursGroup, HoursScope, TimeItem } from './hours';
import { truncateFragment } from './preprocess';
import { isOvernight, sortDays, toMinutes } from './primitives';
import {
  emptyNormalized,
  lowerConfidence,
  type ConditionalRule,
  type DayOfWeek,
  type DayOfWeekHours,
  type HolidayRule,
  type HoursEntry,
  type MonthDay,
  type NormalizedOperatingInfo,
  type NthWeekday,
  type PartialClosed,
  type SeasonalHours,
  type TimeSpan,
  type UnparsedFragment,
} from './types';

/**
 * 조각별 판정을 스키마 한 덩어리로 합친다 (DR-NM-010 ~ 016 · 030 ~ 035).
 *
 * 합치는 일이 따로 있는 이유는 **충돌이 여기서만 보이기 때문**이다. 조각 하나만 보면
 * `연중무휴` 도 `매주 월요일` 도 각자 옳다. 둘이 같은 원문에서 나왔다는 사실은
 * 합칠 때 처음 드러난다.
 *
 * 임의로 하나를 고르지 않는다 — 고르는 순간 결정론성은 남지만 **정확성이 사라진다**.
 */

export interface MergeInput {
  readonly sourceFieldNames: readonly string[];
  readonly closedHits: readonly ClosedHit[];
  readonly hoursGroups: readonly HoursGroup[];
  /** 조각 원문 · 사유 · **영향 경로**. `affects` 가 비면 어떤 경로도 강등하지 않는다 */
  readonly unparsed: readonly UnparsedFragment[];
}

export function mergeNormalized(input: MergeInput): NormalizedOperatingInfo {
  const base = emptyNormalized(input.sourceFieldNames);
  const byPath: Record<string, ParseConfidence> = {};
  const unparsed: UnparsedFragment[] = input.unparsed.map((u) => ({
    fragment: truncateFragment(u.fragment),
    reason: u.reason,
    affects: u.affects,
  }));

  const closed = mergeClosed(input.closedHits, byPath);
  const hours = mergeHours(input.hoursGroups, byPath, unparsed);

  // DR-NM-033 — `affects` 에 담긴 경로는 UNPARSED 로 기록한다.
  // 이게 "해석 실패를 정상으로 판정하지 않는다"(FR-AU-009)를 스키마 안에서 강제하는 지점이다.
  for (const u of unparsed) {
    for (const path of u.affects) byPath[path] = 'UNPARSED';
  }

  return {
    ...base,
    ...closed,
    ...hours,
    confidence: { overall: overallOf(byPath), byPath },
    unparsed,
  };
}

// ── 휴무 축 ───────────────────────────────────────────────────────────

function mergeClosed(
  hits: readonly ClosedHit[],
  byPath: Record<string, ParseConfidence>,
): Partial<NormalizedOperatingInfo> {
  const weekly = new Set<DayOfWeek>();
  const nth: NthWeekday[] = [];
  const fixed = new Set<MonthDay>();
  const holiday = new Set<HolidayRule>();
  const conditional: ConditionalRule[] = [];
  const partial: PartialClosed[] = [];
  let alwaysOpen = false;

  // DR-NM-010 — 배열형 휴무 필드는 합집합으로 병합하고 중복을 제거한다
  for (const hit of hits) {
    switch (hit.kind) {
      case 'ALWAYS_OPEN': alwaysOpen = true; break;
      case 'WEEKLY': for (const d of hit.days) weekly.add(d); break;
      case 'NTH': for (const e of hit.entries) if (!nth.some((x) => x.nth === e.nth && x.day === e.day)) nth.push(e); break;
      case 'FIXED': for (const d of hit.dates) fixed.add(d); break;
      case 'HOLIDAY': for (const r of hit.rules) holiday.add(r); break;
      case 'CONDITIONAL': conditional.push(hit.rule); break;
      case 'PARTIAL': partial.push(hit.partial); break;
      default: break;
    }
  }

  if (weekly.size > 0) byPath.weeklyClosed = 'CONFIRMED';
  if (nth.length > 0) byPath.nthWeekday = 'CONFIRMED';
  if (fixed.size > 0) byPath.fixedClosed = 'CONFIRMED';
  if (holiday.size > 0) byPath.holidayRule = 'CONFIRMED';
  if (partial.length > 0) byPath.partialClosed = 'CONFIRMED';
  // DR-NM-031 — 조건부로 분류된 조각은 신뢰도 추정 고정이다
  if (conditional.length > 0) byPath.conditionalRule = 'ESTIMATED';
  if (alwaysOpen) byPath.alwaysOpen = 'CONFIRMED';

  /*
   * DR-NM-011 — `alwaysOpen` 과 휴무 조각이 함께 나오면 휴관 범위로 갈라 처리한다.
   *   ① 시설 **전체** 휴관   → alwaysOpen 을 내리고 휴무 항목을 유지한다
   *   ② 시설 **일부** 휴관   → alwaysOpen 을 유지하고 예외를 partialClosed 에 담는다
   * 두 경우 모두 해당 경로 신뢰도를 ESTIMATED 로 낮춘다 (DR-NM-032).
   *
   * 조건부 휴무(`※ 기상특보 발령 시 휴무`)는 확정된 휴무일이 아니므로 alwaysOpen 을
   * 내리지 않는다. 조건 경로는 어차피 ESTIMATED 라 차단 근거가 되지 않는다.
   */
  const hasDefiniteClosure = weekly.size > 0 || nth.length > 0 || fixed.size > 0 || holiday.size > 0;
  if (alwaysOpen && hasDefiniteClosure) {
    alwaysOpen = false;
    byPath.alwaysOpen = 'ESTIMATED';
    for (const path of ['weeklyClosed', 'nthWeekday', 'fixedClosed', 'holidayRule']) {
      if (byPath[path] !== undefined) byPath[path] = 'ESTIMATED';
    }
  } else if (alwaysOpen && partial.length > 0) {
    byPath.alwaysOpen = 'ESTIMATED';
    byPath.partialClosed = 'ESTIMATED';
  }

  return {
    alwaysOpen,
    weeklyClosed: sortDays(weekly),
    nthWeekday: [...nth].sort((a, b) => a.nth - b.nth || a.day.localeCompare(b.day)),
    fixedClosed: [...fixed].sort(),
    holidayRule: [...holiday].sort(),
    conditionalRule: conditional,
    partialClosed: partial,
  };
}

// ── 운영시간 축 ───────────────────────────────────────────────────────

function mergeHours(
  groups: readonly HoursGroup[],
  byPath: Record<string, ParseConfidence>,
  unparsed: UnparsedFragment[],
): Partial<NormalizedOperatingInfo> {
  let checkIn: string | null = null;
  let checkOut: string | null = null;

  // DR-NM-026 — 입실/퇴실은 어느 유형에서 나오든 운영시간이 아니다.
  // `open=15:00 / close=11:00` 으로 읽으면 익일 종료(DR-NM-023)가 걸려 심야 영업으로 오판한다
  for (const g of groups) {
    for (const item of g.items) {
      if (item.role === 'CHECK_IN' && checkIn === null) checkIn = item.from;
      if (item.role === 'CHECK_OUT' && checkOut === null) checkOut = item.from;
    }
  }
  if (checkIn !== null) byPath.checkIn = 'CONFIRMED';
  if (checkOut !== null) byPath.checkOut = 'CONFIRMED';

  const timed = groups.filter((g) => g.allDay || g.items.some((i) => i.role === 'OPEN'));

  /*
   * FR-AU-014 — 한 범위 안에 **서로 다른** 운영시간이 둘 이상이면 하나를 고르지 않는다.
   *   `- 전망대 09:00~17:00- 야외공간 09:00~18:00`   (같은 관광지의 서로 다른 시설)
   *   `- 1회차 20:00~20:30- 2회차 20:30~21:00`      (회차별 운영)
   * 첫 값을 운영시간으로 단정하면 절반이 틀린다.
   */
  const ambiguous = timed.filter((g) => distinctOpenCount(g) > 1);
  for (const g of ambiguous) {
    unparsed.push({
      fragment: truncateFragment(openSummary(g)),
      reason: 'CONDITIONAL',
      affects: ['openHours'],
    });
  }
  const usable = timed.filter((g) => distinctOpenCount(g) <= 1);

  const dayGroups = usable.filter((g) => g.scope.kind === 'DAYS');
  const seasonGroups = usable.filter((g) => g.scope.kind === 'SEASON');
  const unknownGroups = usable.filter((g) => g.scope.kind === 'UNKNOWN');
  const defaultGroups = usable.filter((g) => g.scope.kind === 'DEFAULT');

  const dayOfWeekHours = buildDayOfWeekHours(dayGroups, byPath, unparsed);
  const seasonalHours = buildSeasonalHours(seasonGroups, byPath);

  let openHours: HoursEntry | null = null;

  if (defaultGroups.length === 1) {
    openHours = toEntry(defaultGroups[0] as HoursGroup);
    byPath.openHours = 'CONFIRMED';
  } else if (defaultGroups.length > 1) {
    // FR-AU-014 · DR-NM-013 — 라벨 없는 범위가 둘 이상이면 하나를 고르지 않는다
    const distinct = new Set(defaultGroups.map((g) => entryKey(toEntry(g))));
    if (distinct.size === 1) {
      openHours = toEntry(defaultGroups[0] as HoursGroup);
      byPath.openHours = 'CONFIRMED';
    } else {
      for (const g of defaultGroups) {
        unparsed.push({ fragment: truncateFragment(entryKey(toEntry(g))), reason: 'CONDITIONAL', affects: ['openHours'] });
      }
      byPath.openHours = 'UNPARSED';
    }
  }

  if (openHours === null && unknownGroups.length > 0) {
    if (unknownGroups.length === 1) {
      // 시설 라벨이 하나뿐이면 그 시각을 쓰되 확정으로는 보지 않는다
      openHours = toEntry(unknownGroups[0] as HoursGroup);
      byPath.openHours = 'ESTIMATED';
    } else {
      // `[일일개장] … [숙박시설] …` — 어느 쪽이 관광 항목의 운영시간인지 알 수 없다
      for (const g of unknownGroups) {
        const label = g.scope.kind === 'UNKNOWN' ? g.scope.label : '';
        unparsed.push({ fragment: truncateFragment(label), reason: 'CONDITIONAL', affects: ['openHours'] });
      }
      byPath.openHours = 'UNPARSED';
    }
  }

  return { openHours, dayOfWeekHours, seasonalHours, checkIn, checkOut };
}

/** DR-NM-016 — `days` 집합은 서로 겹치지 않아야 한다. 겹치면 DR-NM-013 을 적용한다 */
function buildDayOfWeekHours(
  groups: readonly HoursGroup[],
  byPath: Record<string, ParseConfidence>,
  unparsed: UnparsedFragment[],
): readonly DayOfWeekHours[] {
  if (groups.length === 0) return [];

  const claimed = new Map<DayOfWeek, string>();
  const out: DayOfWeekHours[] = [];
  const conflicts: string[] = [];

  for (const g of groups) {
    const days = g.scope.kind === 'DAYS' ? g.scope.days : [];
    const entry = toEntry(g);
    const key = entryKey(entry);

    const overlapping = days.filter((d) => claimed.has(d) && claimed.get(d) !== key);
    if (overlapping.length > 0) {
      // 같은 요일에 서로 다른 운영시간을 주장한다 — 임의로 하나를 선택하지 않는다
      conflicts.push(`${overlapping.join('·')} ${key}`);
      continue;
    }
    for (const d of days) claimed.set(d, key);
    out.push({ ...entry, days: sortDays(days) });
  }

  /*
   * 충돌한 요일만 빠지고 나머지가 살아남았다면 경로 자체는 여전히 쓸 수 있다.
   * 그래서 `affects` 를 비우고 신뢰도만 추정으로 낮춘다 (DR-NM-032).
   * 하나도 못 살렸을 때만 경로를 확인 불가로 내린다 (DR-NM-033).
   */
  for (const c of conflicts) {
    unparsed.push({
      fragment: truncateFragment(c),
      reason: 'CONDITIONAL',
      affects: out.length === 0 ? ['dayOfWeekHours'] : [],
    });
  }

  byPath.dayOfWeekHours = conflicts.length > 0 ? 'ESTIMATED' : 'CONFIRMED';
  return out;
}

function buildSeasonalHours(
  groups: readonly HoursGroup[],
  byPath: Record<string, ParseConfidence>,
): readonly SeasonalHours[] {
  if (groups.length === 0) return [];

  const out: SeasonalHours[] = [];
  let estimated = false;

  for (const g of groups) {
    const scope = g.scope as Extract<HoursScope, { kind: 'SEASON' }>;
    // 기간 없이 라벨만 있는 계절 구분은 언제부터인지 알 수 없다. 기간을 지어내지 않는다
    if (scope.from === '' || scope.to === '') {
      estimated = true;
      continue;
    }
    out.push({ ...toEntry(g), from: scope.from, to: scope.to, label: scope.label });
  }

  if (out.length > 0) byPath.seasonalHours = estimated ? 'ESTIMATED' : 'CONFIRMED';
  return out;
}

/** 한 그룹의 시각 항목들을 운영시간 한 덩어리로 조립한다 (DR-NM-015) */
function toEntry(group: HoursGroup): HoursEntry {
  if (group.allDay) {
    return { open: '00:00', close: '24:00', breaks: [], admissionCutoff: null };
  }

  const open = group.items.find((i) => i.role === 'OPEN');
  const breaks: TimeSpan[] = group.items
    .filter((i): i is TimeItem & { to: string } => i.role === 'BREAK' && i.to !== null)
    .map((i) => ({ from: i.from, to: i.to }));

  // 매표 마감이 범위로 오면 끝 시각이 마감이다 — `매표시간 09:00~17:00` → 17:00
  /*
   * 마감이 여럿이면 **가장 늦은 값**을 쓴다 — `점심 마지막 주문 15:00 / 저녁 마지막 주문 19:30`.
   *
   * 이른 값을 고르면 저녁 방문이 전부 마감 초과로 잡혀 과탐이 된다. 늦은 값을 고르면
   * 점심 마감을 놓치지만, 관측한 사례에서는 두 마감 사이를 준비시간(`breaks`)이 덮었다.
   * 준비시간 없이 마감만 둘인 콘텐츠는 그 구간을 판정하지 못한다 — 알려진 한계다.
   *
   * 스키마는 `HH:mm | null` 단일값이다 (DR-NM 5-2 · 5-3, 이슈 #16 A안 확정 2026-08-23).
   * 라벨별 마감을 살리려면 DB 컬럼과 결과 화면까지 바뀌는데 판정은 그대로다.
   */
  const cutoffs = group.items
    .filter((i) => i.role === 'CUTOFF')
    .map((i) => i.to ?? i.from)
    .sort((a, b) => toMinutes(b) - toMinutes(a));
  const admissionCutoff = cutoffs[0] ?? null;

  return {
    open: open?.from ?? '00:00',
    close: open?.to ?? open?.from ?? '24:00',
    breaks,
    admissionCutoff,
  };
}

function distinctOpenCount(group: HoursGroup): number {
  return new Set(
    group.items.filter((i) => i.role === 'OPEN').map((i) => `${i.from}~${i.to ?? ''}`),
  ).size;
}

function openSummary(group: HoursGroup): string {
  return group.items.filter((i) => i.role === 'OPEN').map((i) => `${i.label ?? ''} ${i.from}~${i.to ?? ''}`.trim()).join(' / ');
}

/** 두 운영시간 덩어리가 같은 주장인지 비교하기 위한 키 */
function entryKey(e: HoursEntry): string {
  const breaks = e.breaks.map((b) => `${b.from}-${b.to}`).join(',');
  return `${e.open}~${e.close}|${breaks}|${e.admissionCutoff ?? ''}`;
}

// ── 신뢰도 ────────────────────────────────────────────────────────────

/**
 * DR-NM-034 — `overall` 은 `byPath` 의 최솟값이다.
 *
 * **규칙 판정에는 쓰지 않는다.** 규칙은 자기가 참조한 경로의 신뢰도만 본다.
 * 화면 요약 표기 전용이다.
 */
export function overallOf(byPath: Readonly<Record<string, ParseConfidence>>): ParseConfidence {
  const values = Object.values(byPath);
  if (values.length === 0) return 'UNPARSED';
  return values.reduce<ParseConfidence>((acc, v) => lowerConfidence(acc, v), 'CONFIRMED');
}

/** DR-NM-023 — 심야 영업 여부. 규칙엔진이 시각 비교 전에 확인한다 */
export function entryIsOvernight(entry: HoursEntry): boolean {
  return isOvernight(entry.open, entry.close);
}
