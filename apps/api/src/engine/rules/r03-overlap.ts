import { RULE_CONSTANTS, type Severity } from '@tourlint/shared';
import { toMinutes } from '../normalize/primitives';
import type { AuditItem, AuditRule, Finding, ItineraryContext } from './types';

/**
 * R03 — 같은 일차 안 시간 중복 (FR-RU-030 ~ 033).
 *
 * 두 일정이 겹치면 둘 중 하나는 반드시 못 간다. 현장에서야 알게 되므로 오류 등급이다.
 *
 * 판정 전에 종료시간을 보완한다 (FR-RU-031). 보완값으로 내린 판정은 **그 사실을 메시지에
 * 밝힌다** — 사용자가 입력하지 않은 값으로 지적받으면 납득할 수 없기 때문이다.
 */

export const R03_VERSION = '1.0.0';

/** 겹친 분(分). 1분이라도 겹치면 중복이다 (`R03_MIN_OVERLAP_MINUTES`) */
export function overlapMinutes(
  a: { start: string; end: string },
  b: { start: string; end: string },
): number {
  const from = Math.max(toMinutes(a.start), toMinutes(b.start));
  const to = Math.min(toMinutes(a.end), toMinutes(b.end));
  return Math.max(0, to - from);
}

export class R03TimeOverlapRule implements AuditRule {
  readonly code = 'R03';
  readonly version = R03_VERSION;
  readonly defaultSeverity: Severity = 'ERROR';
  readonly requiresExternal = false;

  evaluate(ctx: ItineraryContext): readonly Finding[] {
    const out: Finding[] = [];

    for (const [, sameDay] of groupByDay(ctx.items)) {
      // 순서를 seq 로 고정한다. 입력 순서에 따라 어느 쪽이 targetItemId 가 되는지 흔들리면
      // 같은 상품이 실행마다 다른 finding 을 낸다 (NF-MT-001)
      const items = [...sameDay].sort((x, y) => x.seq - y.seq || x.id - y.id);

      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const finding = compare(items[i] as AuditItem, items[j] as AuditItem);
          if (finding !== null) out.push(finding);
        }
      }
    }
    return out;
  }
}

function compare(first: AuditItem, second: AuditItem): Finding | null {
  const a = span(first);
  const b = span(second);
  // 종료시간을 못 정한 항목(숙박 등)은 구간이 없어 겹칠 수 없다
  if (a === null || b === null) return null;

  const minutes = overlapMinutes(a, b);
  if (minutes < RULE_CONSTANTS.R03_MIN_OVERLAP_MINUTES) return null;

  const estimated = [first, second].filter((x) => x.endTimeSource !== 'INPUT');
  const note =
    estimated.length === 0
      ? ''
      : ` (${estimated.map((x) => x.placeLabel).join(' · ')} 은 기본 체류시간을 적용한 값입니다)`;

  return {
    ruleCode: 'R03',
    ruleVersion: R03_VERSION,
    severity: 'ERROR',
    reasonCode: 'TIME_OVERLAP',
    targetItemId: first.id,
    targetItemId2: second.id,
    // 중복 분(分)을 메시지에 명시한다 (FR-RU-032)
    message:
      `${first.placeLabel}(${a.start}~${a.end}) 와 ${second.placeLabel}(${b.start}~${b.end}) 가 ` +
      `${minutes}분 겹칩니다${note}`,
    evidence: {
      dayNo: first.dayNo,
      overlapMinutes: minutes,
      first: { itemId: first.id, ...a, endTimeSource: first.endTimeSource },
      second: { itemId: second.id, ...b, endTimeSource: second.endTimeSource },
    },
    requiresExternal: false,
    externalSource: null,
    // 보완값으로 내린 판정은 사용자가 실제 소요시간을 확인해야 한다
    needsConfirmation: estimated.length > 0,
  };
}

function span(item: AuditItem): { start: string; end: string } | null {
  return item.endTime === null ? null : { start: item.startTime, end: item.endTime };
}

function groupByDay(items: readonly AuditItem[]): Map<number, AuditItem[]> {
  const map = new Map<number, AuditItem[]>();
  for (const item of items) {
    const bucket = map.get(item.dayNo);
    if (bucket === undefined) map.set(item.dayNo, [item]);
    else bucket.push(item);
  }
  return map;
}
