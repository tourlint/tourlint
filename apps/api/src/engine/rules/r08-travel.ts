import { RULE_CONSTANTS, type ExceptionReasonCode, type Severity } from '@tourlint/shared';
import { toMinutes } from '../normalize/primitives';
import type { AuditItem, AuditRule, Finding, ItineraryContext } from './types';

/**
 * R08 — 이동시간 부족 (FR-RU-080 ~ 086).
 *
 * 연속한 두 일정 사이에 배정된 시간보다 실제 이동이 더 걸리면 뒤 일정이 통째로 밀린다.
 * 현장에서야 알게 되므로 오류 등급이다.
 *
 * **버퍼는 0분이다** (`R08_TRAVEL_BUFFER_MINUTES`). 예상 이동시간이 배정 시간을 넘으면
 * 즉시 오류다. 여유를 두면 "빠듯하지만 되는" 구간을 놓친다.
 *
 * 이동시간은 러너가 미리 조회해 넘긴다 — 규칙은 외부를 부르지 않는다 (NF-PF-014).
 * **대중교통은 아예 판정하지 않는다** (FR-RU-086). 자동차 시간을 대중교통 시간으로
 * 대체해 제시하지 않는다.
 */

export const R08_VERSION = '1.0.0';

/** 구간 하나의 이동 산출값. 러너가 채운다 */
export type TravelSegment =
  | {
      readonly ok: true;
      readonly durationSeconds: number;
      readonly distanceMeters: number;
      /** 미래 운행 정보로 산출했는가. false 면 "현재 시각 기준" 을 화면에 표기해야 한다 */
      readonly futureBased: boolean;
    }
  | { readonly ok: false; readonly reasonCode: ExceptionReasonCode };

export const KAKAO_SOURCE = '카카오모빌리티';

/** `${앞 항목 id}-${뒤 항목 id}` */
export function segmentKey(fromItemId: number, toItemId: number): string {
  return `${fromItemId}-${toItemId}`;
}

/** 같은 일차 안에서 연속한 두 항목의 쌍. 호출 단위이자 판정 단위다 (EI-KM-006) */
export function segmentsOf(items: readonly AuditItem[]): readonly { from: AuditItem; to: AuditItem }[] {
  const byDay = new Map<number, AuditItem[]>();
  for (const item of items) {
    const bucket = byDay.get(item.dayNo);
    if (bucket === undefined) byDay.set(item.dayNo, [item]);
    else bucket.push(item);
  }

  const out: { from: AuditItem; to: AuditItem }[] = [];
  for (const [, dayItems] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...dayItems].sort((a, b) => a.seq - b.seq || a.id - b.id);
    for (let i = 0; i < sorted.length - 1; i++) {
      out.push({ from: sorted[i] as AuditItem, to: sorted[i + 1] as AuditItem });
    }
  }
  return out;
}

/** 앞 일정 종료부터 뒤 일정 시작까지. 종료시간이 없으면 이동에 쓸 시간이 없는 것이다 */
export function allowedMinutes(from: AuditItem, to: AuditItem): number | null {
  if (from.endTime === null) return null;
  return toMinutes(to.startTime) - toMinutes(from.endTime);
}

export class R08TravelTimeRule implements AuditRule {
  readonly code = 'R08';
  readonly version = R08_VERSION;
  readonly defaultSeverity: Severity = 'ERROR';
  /** 외부 산출값을 쓰므로 "외부 참고" 배지가 붙는다 (FR-RU-082 · EI-KM-008) */
  readonly requiresExternal = true;

  evaluate(ctx: ItineraryContext): readonly Finding[] {
    const out: Finding[] = [];

    for (const { from, to } of segmentsOf(ctx.items)) {
      const segment = ctx.travelTimes?.get(segmentKey(from.id, to.id));
      if (segment === undefined) continue;

      // 조회하지 못한 구간은 정상이 아니라 확인 불가다 (FR-AU-009 · EI-KM-009)
      if (!segment.ok) {
        out.push(unverified(from, to, segment.reasonCode));
        continue;
      }

      const allowed = allowedMinutes(from, to);
      if (allowed === null) continue;

      /*
       * 배정 시간이 음수면 두 일정이 겹친 것이다. 그건 R03 이 이미 지적한다.
       * 여기서 또 내면 같은 결함으로 두 번 감점되고, 사용자는 문제가 둘인 줄 안다.
       * 겹침을 먼저 풀어야 이동시간을 따질 수 있다.
       */
      if (allowed < 0) continue;

      const needed = Math.ceil(segment.durationSeconds / 60);
      const shortfall = needed - (allowed + RULE_CONSTANTS.R08_TRAVEL_BUFFER_MINUTES);
      if (shortfall <= 0) continue;

      out.push({
        ruleCode: 'R08',
        ruleVersion: R08_VERSION,
        severity: 'ERROR',
        reasonCode: 'TRAVEL_TIME_SHORT',
        targetItemId: from.id,
        targetItemId2: to.id,
        message:
          `${from.placeLabel} → ${to.placeLabel} 이동에 약 ${needed}분이 걸리는데 ` +
          `배정된 시간은 ${allowed}분입니다. ${shortfall}분이 모자랍니다.` +
          (segment.futureBased ? '' : ' (현재 시각 기준으로 산출한 값입니다)'),
        evidence: {
          allowedMinutes: allowed,
          neededMinutes: needed,
          shortfallMinutes: shortfall,
          distanceMeters: segment.distanceMeters,
          futureBased: segment.futureBased,
          bufferMinutes: RULE_CONSTANTS.R08_TRAVEL_BUFFER_MINUTES,
        },
        requiresExternal: true,
        externalSource: KAKAO_SOURCE,
        needsConfirmation: false,
      });
    }

    return out;
  }
}

function unverified(from: AuditItem, to: AuditItem, reasonCode: ExceptionReasonCode): Finding {
  const transit = reasonCode === 'TRANSIT_NOT_SUPPORTED';
  return {
    ruleCode: 'R08',
    ruleVersion: R08_VERSION,
    severity: 'UNVERIFIED',
    reasonCode,
    targetItemId: from.id,
    targetItemId2: to.id,
    message: transit
      ? `${from.placeLabel} → ${to.placeLabel} 구간별 대중교통 소요시간을 직접 확인해 주세요.`
      : `${from.placeLabel} → ${to.placeLabel} 이동시간을 조회하지 못했습니다. 직접 확인해 주세요.`,
    evidence: { unverified: true, exceptionReasonCode: reasonCode, unit: 'SEGMENT' },
    // 대중교통은 애초에 외부를 부르지 않았으므로 참고 배지를 붙이지 않는다
    requiresExternal: !transit,
    externalSource: transit ? null : KAKAO_SOURCE,
    needsConfirmation: true,
  };
}
