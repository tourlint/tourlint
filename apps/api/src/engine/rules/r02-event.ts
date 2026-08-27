import type { Severity } from '@tourlint/shared';
import { parseIsoDate, type CalendarDate } from '../calendar/dates';
import type { AuditItem, AuditRule, Finding, ItineraryContext } from './types';

/**
 * R02 — 행사 기간 불일치 (FR-RU-020 ~ 023).
 *
 * 축제 · 공연 · 행사(`contentTypeId` = 15)의 개최 기간과 방문 예정일을 견준다.
 * 끝난 행사를 일정에 넣는 것은 **여행사가 실제로 저지르는 사고**이고, 손님이 현장에서
 * 알게 되면 되돌릴 방법이 없다. 그래서 차단이다.
 *
 * **행사 일자가 결측이면 차단하지 않는다** (FR-RU-023). 모르는 것을 틀렸다고 말하지 않는다.
 */

export const R02_VERSION = '1.0.0';

export type EventVerdict = 'IN_PERIOD' | 'ENDED' | 'NOT_STARTED' | 'UNKNOWN';

/**
 * 방문일이 행사 기간 안인가. **경계는 포함이다** — 개막일 · 폐막일 당일은 열려 있다.
 *
 * 한쪽만 있는 기간도 판정한다. 종료일만 알면 "끝났는가" 는 답할 수 있다.
 */
export function evaluateEventPeriod(
  visit: CalendarDate,
  period: { readonly start: string | null; readonly end: string | null },
): EventVerdict {
  const start = period.start === null ? null : parseIsoDate(period.start);
  const end = period.end === null ? null : parseIsoDate(period.end);
  if (start === null && end === null) return 'UNKNOWN';

  const v = key(visit);
  if (end !== null && v > key(end)) return 'ENDED';
  if (start !== null && v < key(start)) return 'NOT_STARTED';
  return 'IN_PERIOD';
}

function key(d: CalendarDate): number {
  return d.year * 10000 + d.month * 100 + d.day;
}

export class R02EventPeriodRule implements AuditRule {
  readonly code = 'R02';
  readonly name = '행사기간 불일치';
  readonly basis = 'KTO_ONLY' as const;
  readonly version = R02_VERSION;
  readonly defaultSeverity: Severity = 'BLOCKER';
  readonly requiresExternal = false;

  evaluate(ctx: ItineraryContext): readonly Finding[] {
    const out: Finding[] = [];
    for (const item of ctx.items) {
      const finding = this.evaluateItem(item);
      if (finding !== null) out.push(finding);
    }
    return out;
  }

  private evaluateItem(item: AuditItem): Finding | null {
    if (item.content === null || item.matchStatus !== 'CONFIRMED') return null;
    // 행사가 아닌 콘텐츠에는 개최 기간이라는 개념이 없다
    if (item.content.contentTypeId !== 15) return null;

    const visit = parseIsoDate(item.date);
    if (visit === null) return null;

    const period = item.content.eventPeriod;
    // FR-RU-023 — 기간이 아예 없으면 차단이 아니라 확인 불가고, 그건 R05 가 올린다.
    // 여기서도 내면 같은 항목이 목록에 두 줄로 뜬다
    if (period === null || (period.start === null && period.end === null)) return null;

    const verdict = evaluateEventPeriod(visit, period);
    if (verdict === 'IN_PERIOD') return null;
    if (verdict === 'UNKNOWN') {
      return unverified(item, `${item.placeLabel} — 행사 기간 정보가 없어 개최 여부를 확인할 수 없습니다`);
    }

    const range = `${period.start ?? '?'} ~ ${period.end ?? '?'}`;
    return {
      ruleCode: 'R02',
      ruleVersion: R02_VERSION,
      severity: 'BLOCKER',
      // 종료 후인지 개시 전인지를 구분해 표시한다 (FR-RU-021)
      reasonCode: verdict === 'ENDED' ? 'EVENT_ENDED' : 'EVENT_NOT_STARTED',
      targetItemId: item.id,
      message:
        verdict === 'ENDED'
          ? `${item.placeLabel} — 행사가 ${period.end ?? ''} 에 끝났습니다 (방문 ${item.date})`
          : `${item.placeLabel} — 행사가 ${period.start ?? ''} 에 시작합니다 (방문 ${item.date})`,
      evidence: { verdict, eventPeriod: period, visitDate: item.date, range },
      requiresExternal: false,
      externalSource: null,
      needsConfirmation: false,
    };
  }
}

function unverified(item: AuditItem, message: string): Finding {
  return {
    ruleCode: 'R02',
    ruleVersion: R02_VERSION,
    severity: 'UNVERIFIED',
    /*
     * 기간이 반쪽만 있어 개최 여부를 못 정한 경우다. `EVENT_ENDED` 를 달면 화면에
     * "행사 종료" 라고 뜬다 — 끝났다고 말하려면 끝난 날짜를 봤어야 한다. 우리가 본 건
     * 날짜가 모자라다는 사실뿐이다
     */
    reasonCode: 'PARSE_MISSING',
    targetItemId: item.id,
    message,
    evidence: { verdict: 'UNKNOWN', visitDate: item.date, unverified: true },
    requiresExternal: false,
    externalSource: null,
    needsConfirmation: true,
  };
}
