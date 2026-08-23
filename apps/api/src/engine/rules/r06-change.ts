import { type Severity } from '@tourlint/shared';
import type { AuditItem, AuditRule, Finding, ItineraryContext } from './types';

/**
 * R06 — 콘텐츠 변경 감지 · R06-b 비표출 전환 (FR-RU-060 ~ 068).
 *
 * 검수는 한 번 하고 끝나는 일이 아니다. 공사 데이터는 계속 바뀌고, 어제 정상이던 일정이
 * 오늘 못 가는 일정이 된다. 이 규칙이 그 변화를 판정에 반영하는 지점이다.
 *
 * **변경 감지 자체는 finding 을 만들지 않는다.** `FR-RU-061` 이 "변경이 감지되면 전 규칙을
 * 재판정하고, R06 자체의 등급은 재판정 결과를 따른다" 고 정한다. 즉 변경은 재판정의
 * **트리거**이지 판정이 아니다. 재판정 결과는 다른 규칙들이 낸다.
 *
 * finding 을 만드는 건 두 경우뿐이다.
 *   · 비표출 전환 — 무조건 차단 (R06-b)
 *   · 정규화 결과 없이 변경만 감지 — 내용을 설명할 수 없으므로 확인 불가 (DR-FP-012)
 */

export const R06_VERSION = '1.0.0';

export class R06ChangeRule implements AuditRule {
  readonly code = 'R06';
  readonly version = R06_VERSION;
  readonly defaultSeverity: Severity = 'BLOCKER';
  readonly requiresExternal = false;

  evaluate(ctx: ItineraryContext): readonly Finding[] {
    const out: Finding[] = [];
    for (const item of ctx.items) {
      const finding = evaluateItem(item);
      if (finding !== null) out.push(finding);
    }
    return out;
  }
}

function evaluateItem(item: AuditItem): Finding | null {
  if (item.content === null || item.matchStatus !== 'CONFIRMED') return null;

  const verdict = item.content.changeVerdict;
  if (verdict === null) return null;

  /*
   * R06-b — 비표출 전환은 **무조건 차단**이다 (FR-RU-065).
   *
   * 사유를 알 수 없어도 판정을 완화하지 않는다. 사유 불명 자체가 차단 근거다 (FR-RU-068).
   * 공사가 내린 콘텐츠를 상품에 남겨두면 안 된다는 것은 승인 회신의 의무 조항이다
   * (PM-NG-009 · SC-DT-009).
   *
   * ⚠️ **일정 항목을 자동으로 지우지 않는다** (FR-RU-066). 항목은 그대로 두고 차단만 건다.
   *    지우면 사용자는 무엇이 사라졌는지 모른 채 일정이 비어 있는 걸 보게 된다.
   */
  if (verdict.kind === 'HIDDEN') {
    return {
      ruleCode: 'R06',
      ruleVersion: R06_VERSION,
      severity: 'BLOCKER',
      reasonCode: 'CONTENT_HIDDEN',
      targetItemId: item.id,
      message:
        `${item.placeLabel} — 공사 데이터에서 비표출로 전환됐습니다. ` +
        `사유는 알 수 없으며 그대로 둘 수 없습니다. 반경 20km 안 같은 유형 관광지로 교체하거나 일정에서 빼 주세요.`,
      evidence: {
        verdict: verdict.kind,
        showFlagTurnedOff: true,
        // 판정 필드 목록까지 달라졌다면 그 사실도 남긴다 (이슈 #13)
        fieldNamesChanged: verdict.fieldNamesChanged,
        ktoContentId: item.content.ktoContentId,
      },
      requiresExternal: false,
      externalSource: null,
      needsConfirmation: false,
    };
  }

  /*
   * DR-FP-012 — 정규화 결과가 없는 지문끼리는 해시만 비교한다. 변경은 감지했지만
   * 무엇이 어떻게 바뀌었는지 설명할 수 없으므로 "내용 확인 불가 · 재확인 필요" 로 알린다.
   */
  if (verdict.kind === 'CHANGED' && item.content.normalized === null) {
    return {
      ruleCode: 'R06',
      ruleVersion: R06_VERSION,
      severity: 'UNVERIFIED',
      reasonCode: 'PARSE_SCHEMA_INVALID',
      targetItemId: item.id,
      message: `${item.placeLabel} — 공사 데이터가 바뀌었지만 내용을 해석하지 못했습니다. 운영기관에 직접 확인해 주세요.`,
      evidence: { verdict: verdict.kind, normalized: null, ktoContentId: item.content.ktoContentId },
      requiresExternal: false,
      externalSource: null,
      needsConfirmation: true,
    };
  }

  // 그 밖의 판정(FIRST · UNCHANGED · CHANGED · INCOMPARABLE)은 finding 을 만들지 않는다.
  // 재판정은 러너가 이미 수행했고, 그 결과는 다른 규칙들이 낸다 (FR-RU-061).
  return null;
}
