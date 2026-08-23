import type { ParseConfidence, ReasonCode, Severity } from '@tourlint/shared';
import {
  addDays, dayOfWeek, isWithinMonthDayRange, nthWeekdayOfMonth, parseIsoDate, toMonthDay,
  type CalendarDate,
} from '../calendar/dates';
import type { HolidayCalendar } from '../calendar/holidays';
import { toMinutes } from '../normalize/primitives';
import type {
  ConditionalRule, DayOfWeek, HoursEntry, NormalizedOperatingInfo, TimeOfDay,
} from '../normalize/types';
import { confidenceOfPaths, type AuditItem, type AuditRule, type Finding, type ItineraryContext } from './types';

/**
 * R01 — 운영시간 · 휴무일 불일치 (FR-RU-010 ~ 014).
 *
 * **DR-NM 5-5 의 5단계 절차를 그대로 구현한다.** 순서를 바꾸거나 생략하지 않는다 (DR-NM-020).
 * 이 절차 자체가 재현성의 정의이기 때문이다 — 순서가 바뀌면 같은 입력에 다른 결과가 나온다.
 *
 *   1단계 휴무 판정      위에서부터, 하나라도 걸리면 즉시 CLOSED
 *   2단계 운영시간 선택   구체성이 높은 것이 이긴다
 *   3단계 시각 판정      채택된 항목에 대해
 *   4단계 등급 매핑
 *   5단계 신뢰도 게이트   4단계 결과에 덮어쓴다
 */

export const R01_VERSION = '1.0.0';

/**
 * 1단계 결과.
 *
 * `path` 는 이 판정이 **실제로 읽은** 스키마 경로다. 5단계 신뢰도 게이트가 이 경로 하나만
 * 본다 — 규칙은 자신이 참조한 경로의 신뢰도만 본다 (DR-NM-034). 휴무 축 전체를 뭉뚱그려
 * 보면 `conditionalRule` 로 내린 판정이 엉뚱하게 확인 불가로 강등된다.
 */
export type ClosedVerdict =
  | { readonly kind: 'CLOSED'; readonly step: string; readonly path: string; readonly detail: string }
  | { readonly kind: 'CLOSED_UNCERTAIN'; readonly step: string; readonly path: string; readonly detail: string }
  | { readonly kind: 'OPEN'; readonly step: string; readonly path: string | null }
  | { readonly kind: 'UNKNOWN'; readonly step: string; readonly path: string | null };

/** 3단계 결과 */
export type HoursVerdict = 'OPEN' | 'OUT_OF_HOURS' | 'IN_BREAK' | 'AFTER_CUTOFF' | 'UNKNOWN';

/**
 * [1단계] 휴무 판정 — **먼저, 그리고 위에서부터.**
 *
 * 하나라도 걸리면 즉시 `CLOSED` 다. 뒤 조건을 더 보지 않는 게 요점이다.
 */
export function evaluateClosed(
  n: NormalizedOperatingInfo,
  date: CalendarDate,
  holidays: HolidayCalendar,
): ClosedVerdict {
  const md = toMonthDay(date);
  const dow = dayOfWeek(date);

  // 1-1 양력 고정일
  if (n.fixedClosed.includes(md)) {
    return { kind: 'CLOSED', step: '1-1', path: 'fixedClosed', detail: `${md} 고정 휴무` };
  }

  // 1-2 명절 · 법정공휴일
  if (n.holidayRule.length > 0) {
    if (!holidays.isSupportedYear(date.year)) {
      // 표에 없는 해를 "공휴일 아님" 으로 답하면 그 해 휴무 판정이 소리 없이 틀린다
      return { kind: 'UNKNOWN', step: '1-2', path: 'holidayRule' };
    }
    for (const rule of n.holidayRule) {
      if (holidays.matches(rule, date)) {
        return { kind: 'CLOSED', step: '1-2', path: 'holidayRule', detail: holidays.nameOf(date) ?? rule };
      }
    }
  }

  // 1-3 매월 N번째 요일
  const nth = nthWeekdayOfMonth(date);
  for (const e of n.nthWeekday) {
    if (e.day === dow && e.nth === nth) {
      return { kind: 'CLOSED', step: '1-3', path: 'nthWeekday', detail: `매월 ${e.nth}번째 ${KOREAN_DAY[e.day]}요일 휴무` };
    }
  }

  // 1-4 매주 요일
  if (n.weeklyClosed.includes(dow)) {
    return { kind: 'CLOSED', step: '1-4', path: 'weeklyClosed', detail: `매주 ${KOREAN_DAY[dow]}요일 휴무` };
  }

  // 1-5 조건부 — 적용될 **여지**가 있으면 확정하지 않고 추정으로 남긴다
  for (const rule of n.conditionalRule) {
    if (conditionalApplies(rule, dow, date, holidays)) {
      return { kind: 'CLOSED_UNCERTAIN', step: '1-5', path: 'conditionalRule', detail: rule.note };
    }
  }

  // 1-6 연중무휴
  if (n.alwaysOpen) return { kind: 'OPEN', step: '1-6', path: 'alwaysOpen' };

  // 1-7 휴무 필드가 모두 비어 있다 — 모른다
  const hasAnyClosedField =
    n.weeklyClosed.length > 0 || n.nthWeekday.length > 0 ||
    n.fixedClosed.length > 0 || n.holidayRule.length > 0;
  return hasAnyClosedField
    ? { kind: 'OPEN', step: '1-6', path: null }
    : { kind: 'UNKNOWN', step: '1-7', path: null };
}

/**
 * 조건부 휴무가 그 날짜에 적용될 **여지**가 있는가.
 *
 * 여지가 있다는 것만 말하고 확정하지 않는다 — 그래서 결과가 `CLOSED_UNCERTAIN` 이다.
 *
 * `월요일이 공휴일인 경우 그 다음날 휴관` 에서 정작 중요한 날은 **화요일**이다.
 * 방문일 자체가 공휴일인지 보면 안 되고 **전날**을 봐야 한다. 앞의 조건(1-4)이 월요일을
 * 이미 잡으므로, 이 조건이 실제로 일하는 지점은 공휴일 다음 날뿐이다.
 */
function conditionalApplies(
  rule: ConditionalRule,
  dow: DayOfWeek,
  date: CalendarDate,
  holidays: HolidayCalendar,
): boolean {
  // 대상이 특정되지 않은 조건(`기상특보 발령 시 휴무`)은 어느 날이든 여지가 있다
  if (rule.appliesTo.length === 0) return true;
  if (rule.appliesTo.includes(dow)) return true;

  if (rule.kind !== 'HOLIDAY_NEXT_DAY') return false;
  if (!holidays.isSupportedYear(date.year)) return false;

  const previous = addDays(date, -1);
  return rule.appliesTo.includes(dayOfWeek(previous)) && holidays.matches('LEGAL_HOLIDAY', previous);
}

export interface SelectedHours {
  readonly entry: HoursEntry;
  readonly source: 'dayOfWeekHours' | 'seasonalHours' | 'openHours';
  /** 2-1 과 2-2 가 동시에 매칭되고 상충했는가 (신뢰도를 낮춘다) */
  readonly conflicted: boolean;
}

/**
 * [2단계] 운영시간 선택 — **구체성이 높은 것이 이긴다.**
 *
 * 요일별 > 계절별 > 기본. 둘이 동시에 매칭되고 값이 상충하면 요일별을 채택하되
 * 그 경로의 신뢰도를 `ESTIMATED` 로 낮춘다.
 */
export function selectHours(n: NormalizedOperatingInfo, date: CalendarDate): SelectedHours | null {
  const dow = dayOfWeek(date);
  const md = toMonthDay(date);

  const byDay = n.dayOfWeekHours.find((h) => h.days.includes(dow));
  const bySeason = n.seasonalHours.find((h) => isWithinMonthDayRange(md, h.from, h.to));

  if (byDay !== undefined) {
    const conflicted = bySeason !== undefined && (bySeason.open !== byDay.open || bySeason.close !== byDay.close);
    return { entry: byDay, source: 'dayOfWeekHours', conflicted };
  }
  if (bySeason !== undefined) return { entry: bySeason, source: 'seasonalHours', conflicted: false };
  if (n.openHours !== null) return { entry: n.openHours, source: 'openHours', conflicted: false };
  return null;
}

/**
 * [3단계] 시각 판정.
 *
 * 명세는 방문 시각 `T` 하나로 적혀 있지만, 실제 판정은 **방문 구간 `[start, end]`** 으로 한다.
 * 기대값 표 TP-02 가 `17:30~18:30` 방문을 "운영 종료 18:00 을 30분 초과" 로 **차단**이라 못박고
 * 있어서다. 시작 시각만 보면 `17:30 < 18:00` 이라 정상이 되어 그 케이스를 놓친다.
 * 시작 시각만 오는 항목(종료시간 미보완)은 점으로 판정한다.
 */
export function evaluateHours(entry: HoursEntry, start: TimeOfDay, end: TimeOfDay | null): HoursVerdict {
  const open = toMinutes(entry.open);
  const close = toMinutes(entry.close);
  const s = toMinutes(start);
  const e = end === null ? s : toMinutes(end);

  // DR-NM-023 — close 가 open 보다 이르면 익일 종료(심야 영업)다
  const overnight = close <= open;

  // 3-1 운영시간을 벗어나는가. 경계는 포함이다 — 정각 도착·정각 퇴장은 정상
  if (overnight) {
    if (!inOvernightWindow(s, open, close) || !inOvernightWindow(e, open, close, true)) {
      return 'OUT_OF_HOURS';
    }
  } else if (s < open || e > close) {
    return 'OUT_OF_HOURS';
  }

  // 3-2 휴게 · 준비시간에 걸치는가
  for (const b of entry.breaks) {
    if (overlaps(s, e, toMinutes(b.from), toMinutes(b.to))) return 'IN_BREAK';
  }

  // 3-3 입장 · 주문 마감을 넘겨 **도착**했는가
  if (entry.admissionCutoff !== null && s > toMinutes(entry.admissionCutoff)) return 'AFTER_CUTOFF';

  return 'OPEN';
}

/** 심야 영업 구간 — `[open, 24:00) ∪ [00:00, close]` */
function inOvernightWindow(t: number, open: number, close: number, inclusiveEnd = false): boolean {
  return t >= open || (inclusiveEnd ? t <= close : t < close);
}

/** 두 구간이 1분이라도 겹치는가. 끝과 시작이 맞닿은 것은 겹침이 아니다 */
function overlaps(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return aFrom < bTo && bFrom < aTo;
}

/** [4단계] 등급 매핑 */
const SEVERITY_BY_VERDICT: Readonly<Record<string, { severity: Severity; reason: ReasonCode }>> = {
  CLOSED: { severity: 'BLOCKER', reason: 'REST_DAY_CONFLICT' },
  OUT_OF_HOURS: { severity: 'BLOCKER', reason: 'OPEN_HOUR_CONFLICT' },
  AFTER_CUTOFF: { severity: 'ERROR', reason: 'ADMISSION_CUTOFF' },
  IN_BREAK: { severity: 'WARNING', reason: 'IN_BREAK_TIME' },
  CLOSED_UNCERTAIN: { severity: 'WARNING', reason: 'REST_DAY_UNCERTAIN' },
};

const KOREAN_DAY: Readonly<Record<DayOfWeek, string>> = {
  MON: '월', TUE: '화', WED: '수', THU: '목', FRI: '금', SAT: '토', SUN: '일',
};

export class R01OperatingRule implements AuditRule {
  readonly code = 'R01';
  readonly version = R01_VERSION;
  readonly defaultSeverity: Severity = 'BLOCKER';
  readonly requiresExternal = false;

  evaluate(ctx: ItineraryContext): readonly Finding[] {
    const findings: Finding[] = [];
    for (const item of ctx.items) {
      findings.push(...this.evaluateItem(item, ctx.holidays));
    }
    return findings;
  }

  private evaluateItem(item: AuditItem, holidays: HolidayCalendar): readonly Finding[] {
    // 매칭되지 않은 항목은 판정 대상이 아니다 — R05 가 다룬다
    if (item.content === null || item.matchStatus !== 'CONFIRMED') return [];

    // FR-AU-011 — 숙박은 R01 대상이 아니다. 입실 · 퇴실만 해석해 F09 가 쓴다
    if (item.content.contentTypeId === 32 || item.itemType === 'LODGING') return [];

    const n = item.content.normalized;
    const date = parseIsoDate(item.date);
    // 파싱 전면 실패 · 날짜 이상 — 정상으로 판정하지 않는다 (FR-AU-009)
    if (n === null || date === null) return [unverified(item, '운영정보를 해석하지 못했습니다')];

    const findings: Finding[] = [];

    // DR-NM-022 — partialClosed 는 등급과 무관하게 **별도** 주의를 만든다
    findings.push(...partialClosedFindings(item, n, date, holidays));

    const closed = evaluateClosed(n, date, holidays);

    // DR-NM-021 — 닫힌 날의 시각 비교는 무의미하며 finding 중복을 만든다
    if (closed.kind === 'CLOSED' || closed.kind === 'CLOSED_UNCERTAIN') {
      const map = SEVERITY_BY_VERDICT[closed.kind];
      if (map === undefined) return findings;
      // 이 판정이 실제로 읽은 경로 하나만 본다 (DR-NM-034)
      const confidence = confidenceOfPaths(n, [closed.path]);
      findings.push(
        gate({
          item,
          severity: map.severity,
          reasonCode: map.reason,
          message: `${item.placeLabel} — ${dateLabel(date)} ${closed.detail}`,
          confidence,
          // 1-5 는 그 자체로 이미 추정이다. 확인 필요 목록에 함께 올린다
          needsConfirmation: closed.kind === 'CLOSED_UNCERTAIN',
          evidence: { step: closed.step, verdict: closed.kind, date: item.date, dayOfWeek: dayOfWeek(date), confidence },
        }),
      );
      return findings;
    }

    if (closed.kind === 'UNKNOWN') {
      findings.push(unverified(item, `${item.placeLabel} — 휴무일 정보를 확인할 수 없습니다`, {
        step: closed.step, date: item.date,
      }));
      return findings;
    }

    // ── 2 · 3단계 ──
    const selected = selectHours(n, date);
    if (selected === null) {
      findings.push(unverified(item, `${item.placeLabel} — 운영시간 정보를 확인할 수 없습니다`, {
        step: '2-4', date: item.date,
      }));
      return findings;
    }

    const verdict = evaluateHours(selected.entry, item.startTime, item.endTime);
    if (verdict === 'OPEN' || verdict === 'UNKNOWN') return findings;

    const map = SEVERITY_BY_VERDICT[verdict];
    if (map === undefined) return findings;

    let confidence = confidenceOfPaths(n, [selected.source]);
    // 2-1 과 2-2 가 상충하면 채택한 경로의 신뢰도를 낮춘다 (DR-NM 5-5 2단계 단서)
    if (selected.conflicted && confidence === 'CONFIRMED') confidence = 'ESTIMATED';

    findings.push(
      gate({
        item,
        severity: map.severity,
        reasonCode: map.reason,
        message: hoursMessage(item, selected.entry, verdict),
        confidence,
        needsConfirmation: false,
        evidence: {
          step: verdict, source: selected.source, date: item.date,
          visit: { start: item.startTime, end: item.endTime },
          hours: selected.entry, confidence,
        },
      }),
    );
    return findings;
  }
}

/**
 * [5단계] 신뢰도 게이트 — 4단계 결과에 **덮어쓴다** (FR-AU-008).
 *
 *   ESTIMATED  차단을 주의로 강등하고 확인 필요 목록에 동시 등록
 *   UNPARSED   확인 불가로 강등
 *
 * 추정으로 차단을 내리면 멀쩡한 일정을 막는다. 반대로 조용히 통과시키면 못 잡는다.
 * 강등하되 목록에 남기는 것이 둘 사이의 답이다.
 */
function gate(input: {
  item: AuditItem;
  severity: Severity;
  reasonCode: ReasonCode;
  message: string;
  confidence: ParseConfidence;
  needsConfirmation: boolean;
  evidence: Readonly<Record<string, unknown>>;
}): Finding {
  let severity = input.severity;
  let needsConfirmation = input.needsConfirmation;

  if (input.confidence === 'UNPARSED') {
    severity = 'UNVERIFIED';
    needsConfirmation = true;
  } else if (input.confidence === 'ESTIMATED' && severity === 'BLOCKER') {
    severity = 'WARNING';
    needsConfirmation = true;
  }

  return {
    ruleCode: 'R01',
    ruleVersion: R01_VERSION,
    severity,
    reasonCode: input.reasonCode,
    targetItemId: input.item.id,
    message: input.message,
    evidence: { ...input.evidence, gatedFrom: input.severity === severity ? null : input.severity },
    requiresExternal: false,
    externalSource: null,
    needsConfirmation,
  };
}

/**
 * DR-NM-022 — `partialClosed` 가 그 날짜에 해당하면 **등급과 무관하게** 주의를 별도로 만들고
 * 어느 시설 부분이 휴관인지 메시지에 담는다. 전체 휴무가 아니므로 차단하지 않는다.
 */
function partialClosedFindings(
  item: AuditItem,
  n: NormalizedOperatingInfo,
  date: CalendarDate,
  holidays: HolidayCalendar,
): readonly Finding[] {
  const md = toMonthDay(date);
  const out: Finding[] = [];

  for (const p of n.partialClosed) {
    const hit = p.on.some((on) =>
      on === 'LUNAR_NEW_YEAR' || on === 'CHUSEOK' || on === 'LEGAL_HOLIDAY'
        ? holidays.isSupportedYear(date.year) && holidays.matches(on, date)
        : on === md,
    );
    if (!hit) continue;

    out.push({
      ruleCode: 'R01',
      ruleVersion: R01_VERSION,
      severity: 'WARNING',
      reasonCode: 'REST_DAY_UNCERTAIN',
      targetItemId: item.id,
      message: `${item.placeLabel} — ${dateLabel(date)} ${p.scope} 휴관 (시설 일부)`,
      evidence: { step: 'DR-NM-022', scope: p.scope, on: p.on, date: item.date },
      requiresExternal: false,
      externalSource: null,
      needsConfirmation: true,
    });
  }
  return out;
}

function unverified(item: AuditItem, message: string, evidence: Record<string, unknown> = {}): Finding {
  return {
    ruleCode: 'R01',
    ruleVersion: R01_VERSION,
    severity: 'UNVERIFIED',
    reasonCode: 'REST_DAY_UNCERTAIN',
    targetItemId: item.id,
    message,
    evidence: { ...evidence, unverified: true },
    requiresExternal: false,
    externalSource: null,
    needsConfirmation: true,
  };
}

function hoursMessage(item: AuditItem, entry: HoursEntry, verdict: HoursVerdict): string {
  const visit = item.endTime === null ? item.startTime : `${item.startTime}~${item.endTime}`;
  switch (verdict) {
    case 'OUT_OF_HOURS':
      return `${item.placeLabel} — 방문 ${visit} 이 운영시간 ${entry.open}~${entry.close} 을 벗어납니다`;
    case 'AFTER_CUTOFF':
      return `${item.placeLabel} — 도착 ${item.startTime} 이 마감 ${entry.admissionCutoff ?? ''} 이후입니다`;
    case 'IN_BREAK':
      return `${item.placeLabel} — 방문 ${visit} 이 휴게시간에 걸칩니다`;
    default:
      return `${item.placeLabel} — 운영시간 확인이 필요합니다`;
  }
}

function dateLabel(date: CalendarDate): string {
  return `${date.month}/${date.day}(${KOREAN_DAY[dayOfWeek(date)]})`;
}
