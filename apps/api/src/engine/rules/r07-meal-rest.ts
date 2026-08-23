import { type Severity } from '@tourlint/shared';
import { toMinutes } from '../normalize/primitives';
import type { AuditItem, AuditRule, AuditSettings, Finding, ItineraryContext } from './types';

/**
 * R07 — 식사 · 휴식 누락 (FR-RU-070 ~ 073).
 *
 * 하루 종일 쉬지 않고 도는 일정은 손님이 지친다. 여행사가 일정을 빽빽하게 짜다 흔히 놓치는
 * 것이라 잡아준다. 다만 못 가는 일정이 되는 건 아니므로 주의 등급이다.
 *
 * 외부 호출도 공사 데이터도 필요 없다. 일정표만 보면 판정된다.
 */

export const R07_VERSION = '1.0.0';

export type MealRestVerdict = 'OK' | 'SHORT_SPAN' | 'MEAL_TIME_SHORT' | 'MEAL_REST_MISSING';

export interface DaySpan {
  readonly dayNo: number;
  /** 그 일차의 첫 항목 시작 */
  readonly from: string;
  /** 마지막 끝점. 숙박은 **체크인 시각**이 끝점이다 */
  readonly to: string;
  readonly minutes: number;
}

/**
 * 일차의 연속 일정 시간.
 *
 * 끝점을 잡는 규칙이 요점이다 — **숙박 항목은 시작 시각이 끝점**이다. 체크인은 그 날 일정의
 * 끝이자 휴식의 시작이고, 숙박에는 종료시간이 없다(FR-AU-011 로 체류시간 보완도 하지 않는다).
 * 종료시간이 없는 다른 항목은 시작 시각을 그대로 끝점으로 본다.
 */
export function daySpan(items: readonly AuditItem[]): DaySpan | null {
  if (items.length === 0) return null;

  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const start = toMinutes(item.startTime);
    const end = item.itemType === 'LODGING' || item.endTime === null ? start : toMinutes(item.endTime);
    if (start < from) from = start;
    if (end > to) to = end;
  }

  return {
    dayNo: items[0]?.dayNo ?? 0,
    from: fromMinutes(from),
    to: fromMinutes(to),
    minutes: Math.max(0, to - from),
  };
}

/**
 * 한 일차를 판정한다.
 *
 * **충분한 휴게가 하나라도 있으면 통과다.** 명세는 조건을 둘로 나눠 적었는데
 * (`FR-RU-070` 식사 또는 휴식 항목 부재 · `FR-RU-071` 식사 시간 부족), 둘을 함께 읽으면
 * "그 날 제대로 쉰 구간이 있었나" 하나의 질문이다.
 *
 * ⚠️ 휴식(`REST`) 항목에는 명세가 최소 시간을 걸지 않았다. 5분짜리 휴식도 조건을 만족시킨다.
 *    명세대로 구현하고 그 구멍은 이슈로 남긴다 — 임의로 기준을 지어내지 않는다.
 */
export function evaluateDay(items: readonly AuditItem[], settings: AuditSettings): MealRestVerdict {
  const span = daySpan(items);
  if (span === null) return 'OK';
  if (span.minutes < settings.r07SpanHours * 60) return 'SHORT_SPAN';

  const meals = items.filter((i) => i.itemType === 'MEAL');
  const hasRest = items.some((i) => i.itemType === 'REST');
  const hasAdequateMeal = meals.some((m) => durationMinutes(m) >= settings.r07MealMinutes);

  if (hasAdequateMeal || hasRest) return 'OK';
  // 식사를 넣긴 했는데 시간이 모자란 경우와, 아예 없는 경우를 사유코드로 가른다
  return meals.length > 0 ? 'MEAL_TIME_SHORT' : 'MEAL_REST_MISSING';
}

/** 배정 시간. 종료시간이 없으면 0분으로 본다 — 시간을 배정하지 않은 것이다 */
function durationMinutes(item: AuditItem): number {
  if (item.endTime === null) return 0;
  return Math.max(0, toMinutes(item.endTime) - toMinutes(item.startTime));
}

export class R07MealRestRule implements AuditRule {
  readonly code = 'R07';
  readonly version = R07_VERSION;
  readonly defaultSeverity: Severity = 'WARNING';
  readonly requiresExternal = false;

  evaluate(ctx: ItineraryContext): readonly Finding[] {
    const out: Finding[] = [];

    for (const [dayNo, items] of groupByDay(ctx.items)) {
      const verdict = evaluateDay(items, ctx.settings);
      if (verdict === 'OK' || verdict === 'SHORT_SPAN') continue;

      const span = daySpan(items);
      if (span === null) continue;

      const meals = items.filter((i) => i.itemType === 'MEAL');
      // 시간이 모자란 쪽은 그 식사 항목을 지목한다. 아예 없으면 지목할 항목이 없다
      const longest = meals.reduce<AuditItem | null>(
        (best, m) => (best === null || durationMinutes(m) > durationMinutes(best) ? m : best),
        null,
      );

      out.push({
        ruleCode: 'R07',
        ruleVersion: R07_VERSION,
        severity: 'WARNING',
        reasonCode: verdict,
        targetItemId: verdict === 'MEAL_TIME_SHORT' ? (longest?.id ?? null) : null,
        message: message(verdict, dayNo, span, longest, ctx.settings),
        evidence: {
          dayNo,
          span: { from: span.from, to: span.to, minutes: span.minutes },
          mealMinutes: longest === null ? null : durationMinutes(longest),
          thresholds: { spanHours: ctx.settings.r07SpanHours, mealMinutes: ctx.settings.r07MealMinutes },
        },
        requiresExternal: false,
        externalSource: null,
        needsConfirmation: false,
      });
    }

    return out;
  }
}

function message(
  verdict: MealRestVerdict,
  dayNo: number,
  span: DaySpan,
  longest: AuditItem | null,
  settings: AuditSettings,
): string {
  const hours = (span.minutes / 60).toFixed(1).replace(/\.0$/, '');
  const head = `${dayNo}일차 ${span.from}~${span.to} 연속 ${hours}시간`;

  if (verdict === 'MEAL_REST_MISSING') {
    return `${head} 일정에 식사·휴식 항목이 없습니다. 공백 구간에 식사를 넣어 주세요.`;
  }
  const label = longest?.placeLabel ?? '식사';
  const minutes = longest === null ? 0 : durationMinutes(longest);
  return `${head} 중 식사(${label})가 ${minutes}분으로 최소 ${settings.r07MealMinutes}분보다 짧습니다. 시간을 늘리거나 뒤 일정을 미뤄 주세요.`;
}

function groupByDay(items: readonly AuditItem[]): Map<number, AuditItem[]> {
  const map = new Map<number, AuditItem[]>();
  for (const item of items) {
    const bucket = map.get(item.dayNo);
    if (bucket === undefined) map.set(item.dayNo, [item]);
    else bucket.push(item);
  }
  // 일차 순서를 고정한다 — finding 순서가 실행마다 달라지면 안 된다 (NF-MT-001)
  return new Map([...map.entries()].sort((a, b) => a[0] - b[0]));
}

function fromMinutes(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
