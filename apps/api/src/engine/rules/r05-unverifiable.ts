import type { ExceptionReasonCode, Severity } from '@tourlint/shared';
import type { AuditItem, AuditRule, Finding, ItineraryContext } from './types';

/**
 * R05 — 데이터 검증 불가 (FR-RU-050 ~ 052).
 *
 * **다른 규칙이 물음을 던지지도 못한 항목을 맡는다.** R01·R02·R06 은 매칭이 확정되지
 * 않은 항목에서 그냥 물러난다(`return []`). 그러면 그 항목은 결과에 한 줄도 안 남고,
 * 화면에서는 아무 문제 없이 검수를 통과한 것처럼 보인다. 정보가 없다는 이유로 정상
 * 판정을 하는 셈이라 `FR-RU-051` 이 금지하는 동작이다.
 *
 * 여기서 나온 finding 은 F07 확인 필요 목록의 입력이 되고 **수정안을 만들지 않는다**
 * (`FR-RU-052`). 무엇을 고쳐야 할지 우리가 모르는 상태이기 때문이다.
 *
 * ## 어디까지가 R05 인가
 *
 * | 상황 | 누가 | 왜 |
 * |---|---|---|
 * | 매칭 미확정 (`PENDING`) | **R05** | 붙일 공사 데이터가 없어 어떤 물음도 못 던진다 |
 * | 행사 기간 결측 | **R05** | `FR-RU-023` — 차단하지 않고 이관한다 |
 * | 콘텐츠 조회 실패 | **R05** | 러너가 실패 사유와 함께 남긴다 |
 * | 휴무·운영시간 해석 실패 | R01 | 물음은 던졌고 그 판정 경로의 산출물이다 |
 * | 길찾기 실패 · 좌표 없음 | R08 | 구간 단위라 항목 단위로 옮기면 짝을 잃는다 |
 *
 * 사용자가 직접 **제외**한 항목은 지적하지 않는다. 그건 "정보가 없어서" 가 아니라
 * "대상이 아니어서" 빠진 것이고, 자기가 뺀 항목을 매번 확인 불가로 돌려받으면 목록이
 * 못 쓰게 된다.
 */

export const R05_VERSION = '1.0.0';

/** 행사 콘텐츠 유형 */
const EVENT_CONTENT_TYPE = 15;

interface Gap {
  readonly reasonCode: ExceptionReasonCode;
  readonly message: string;
  readonly evidence: Record<string, unknown>;
}

/** 이 항목이 왜 판정 불가인가. 판정 가능하면 null */
export function findGap(item: AuditItem): Gap | null {
  // 사용자가 뺀 항목이다. 우리가 모르는 것이 아니라 볼 필요가 없는 것이다
  if (item.matchStatus === 'EXCLUDED') return null;

  /*
   * 확정이 아니면 붙일 데이터가 없다.
   *
   * `PENDING` 은 후보를 아직 못 고른 것이고, 그 상태로는 어떤 규칙도 물음을 못 던진다.
   * 후보가 아예 없었는지 고르다 만 것인지는 이 시점에 남아 있지 않아 한 코드로 묶는다 —
   * 둘을 구분하는 척하려면 매칭 단계가 그 사실을 실어 보내야 한다.
   */
  if (item.matchStatus !== 'CONFIRMED') {
    return {
      reasonCode: 'PLACE_UNRESOLVED',
      message: `${item.placeLabel} — 어느 관광지인지 확정되지 않아 검수하지 못했습니다.`,
      evidence: { unverified: true, unit: 'ITEM', matchStatus: item.matchStatus },
    };
  }

  // 조회 실패는 러너가 실패 사유를 들고 따로 남긴다. 여기서 또 내면 두 줄이 된다
  if (item.content === null) return null;

  /*
   * 행사인데 기간을 모른다. 차단하지 않는다 (FR-RU-023) — 기간이 없다는 건 끝났다는
   * 뜻이 아니다. 끝났다고 말하려면 끝난 날짜를 봤어야 한다.
   */
  if (item.content.contentTypeId === EVENT_CONTENT_TYPE) {
    const period = item.content.eventPeriod;
    if (period === null || (period.start === null && period.end === null)) {
      return {
        reasonCode: 'PARSE_MISSING',
        message: `${item.placeLabel} — 행사 기간 정보가 없어 개최 여부를 확인할 수 없습니다.`,
        evidence: { unverified: true, unit: 'ITEM', visitDate: item.date, eventPeriod: period },
      };
    }
  }

  return null;
}

export class R05UnverifiableRule implements AuditRule {
  readonly code = 'R05';
  readonly name = '데이터 검증 불가';
  readonly basis = 'KTO_ONLY' as const;
  readonly version = R05_VERSION;
  readonly defaultSeverity: Severity = 'UNVERIFIED';
  readonly requiresExternal = false;

  evaluate(ctx: ItineraryContext): readonly Finding[] {
    const out: Finding[] = [];
    for (const item of ctx.items) {
      const gap = findGap(item);
      if (gap === null) continue;
      out.push({
        ruleCode: 'R05',
        ruleVersion: R05_VERSION,
        severity: 'UNVERIFIED',
        reasonCode: gap.reasonCode,
        targetItemId: item.id,
        message: gap.message,
        evidence: { ...gap.evidence, exceptionReasonCode: gap.reasonCode },
        requiresExternal: false,
        externalSource: null,
        // 확인 필요 목록에 오른다 (FR-AU-080)
        needsConfirmation: true,
      });
    }
    return out;
  }
}
