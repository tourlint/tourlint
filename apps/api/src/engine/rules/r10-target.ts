import {
  LCLS_SYSTM2, RULE_CONSTANTS, TARGET_LABEL, CONCEPT_LABEL,
  type ConceptKey, type ContentTypeId, type Severity, type TargetKey,
} from '@tourlint/shared';
import { toMinutes } from '../normalize/primitives';
import { confirmedItems } from './types';
import type { AuditItem, AuditRule, Finding, ItineraryContext } from './types';

/**
 * R10 — 상품 타깃 · 콘텐츠 적합성 (FR-RU-100 ~ 104).
 *
 * 「20대 감성 여행」이라 해 놓고 일정이 전부 역사유적지면 손님이 기대한 것과 다르다.
 * 현장에서 알게 되는 결함이 아니라 구성표만 봐도 보이는 것이라 주의 등급이다.
 *
 * ⚠️ **판매량 · 시장 반응 · 흥행을 말하지 않는다** (FR-RU-104). 「안 팔린다」가 아니라
 *    「적어 둔 콘셉트와 일정이 안 맞는다」다. 우리가 관측할 수 있는 것은 후자뿐이다.
 *
 * 판정 단위는 **상품**이다 — 일차가 아니다. 기대 프로파일이 상품 하나에 하나뿐이라
 * 결손도 상품 단위로 센다.
 *
 * 기대 프로파일은 러너가 계정 설정에서 읽어 넘긴다. 규칙은 DB 를 보지 않는다 (NF-PF-014).
 */

export const R10_VERSION = '1.0.0';

/**
 * 이 상품에 적용할 기대 프로파일. 러너가 채운다.
 *
 * `ok: false` 는 **타깃 · 콘셉트를 적었는데 그 조합의 프로파일이 없는** 경우다. 설정이
 * 빠진 것이지 상품 결함이 아니라 확인 불가로 남긴다. 타깃 · 콘셉트를 아예 안 적은
 * 상품은 이 값이 `undefined` 고 R10 이 조용히 물러난다 — 선택 입력이기 때문이다.
 */
export type TargetProfileContext =
  | {
      readonly ok: true;
      readonly targetKey: TargetKey;
      readonly conceptKey: ConceptKey;
      readonly expectedLcls2: readonly string[];
      readonly expectsNight: boolean;
    }
  | { readonly ok: false; readonly targetKey: string; readonly conceptKey: string };

export const NIGHT_FROM_MINUTES = toMinutes(RULE_CONSTANTS.R10_NIGHT_SLOT_FROM);

/** 일정 구성 집계 (FR-RU-101) */
export interface ItinerarySummary {
  /** 중분류별 건수 */
  readonly byLcls2: ReadonlyMap<string, number>;
  /** `contentTypeId` 별 건수 */
  readonly byContentType: ReadonlyMap<ContentTypeId, number>;
  /** 신분류체계 소분류별 건수 */
  readonly byLcls3: ReadonlyMap<string, number>;
  /** 19:00 이후 시작하는 항목이 있는가 */
  readonly hasNight: boolean;
}

export function summarize(items: readonly AuditItem[]): ItinerarySummary {
  const byLcls2 = new Map<string, number>();
  const byContentType = new Map<ContentTypeId, number>();
  const byLcls3 = new Map<string, number>();
  let hasNight = false;

  for (const item of items) {
    if (item.lclsSystm2 !== null) byLcls2.set(item.lclsSystm2, (byLcls2.get(item.lclsSystm2) ?? 0) + 1);
    if (item.lclsSystm3 !== null) byLcls3.set(item.lclsSystm3, (byLcls3.get(item.lclsSystm3) ?? 0) + 1);
    const typeId = item.content?.contentTypeId;
    if (typeId !== undefined) byContentType.set(typeId, (byContentType.get(typeId) ?? 0) + 1);
    // 시작 시각으로 본다. 종료가 밤으로 넘어가는 것은 야간 콘텐츠가 아니라 늦게 끝나는 것이다
    if (toMinutes(item.startTime) >= NIGHT_FROM_MINUTES) hasNight = true;
  }

  return { byLcls2, byContentType, byLcls3, hasNight };
}

/** 기대 항목 중 일정에 0건인 것 (FR-RU-102) */
export function missingTypes(
  summary: ItinerarySummary,
  expectedLcls2: readonly string[],
): readonly string[] {
  return expectedLcls2.filter((code) => (summary.byLcls2.get(code) ?? 0) === 0);
}

export class R10TargetFitRule implements AuditRule {
  readonly code = 'R10';
  readonly version = R10_VERSION;
  readonly defaultSeverity: Severity = 'WARNING';
  /** 외부 산출값을 쓰지 않는다. 상품 정보와 계정 설정만으로 판정한다 */
  readonly requiresExternal = false;

  evaluate(ctx: ItineraryContext): readonly Finding[] {
    const profile = ctx.targetProfile;
    // 타깃·콘셉트를 안 적은 상품이다. 선택 입력이라 결함이 아니다
    if (profile === undefined || profile === null) return [];

    if (!profile.ok) {
      return [{
        ruleCode: 'R10',
        ruleVersion: R10_VERSION,
        severity: 'UNVERIFIED',
        reasonCode: 'NOT_FOUND',
        targetItemId: null,
        message:
          `타깃 · 콘셉트(${profile.targetKey} · ${profile.conceptKey})에 해당하는 기대 프로파일이 ` +
          '설정에 없습니다. 설정 화면에서 추가해 주세요.',
        evidence: {
          unverified: true, exceptionReasonCode: 'NOT_FOUND', unit: 'RULE',
          targetKey: profile.targetKey, conceptKey: profile.conceptKey,
        },
        requiresExternal: false,
        externalSource: null,
        needsConfirmation: true,
      }];
    }

    const items = confirmedItems(ctx.items);
    // 셀 것이 없으면 결손을 말할 수 없다. 그 항목들은 R05 가 이미 지적한다
    if (items.length === 0) return [];

    const summary = summarize(items);
    const missing = missingTypes(summary, profile.expectedLcls2);
    const nightMissing = profile.expectsNight && !summary.hasNight;
    if (missing.length === 0 && !nightMissing) return [];

    const labels = missing.map((code) => LCLS_SYSTM2[code]?.name ?? code);
    if (nightMissing) labels.push(`${RULE_CONSTANTS.R10_NIGHT_SLOT_FROM} 이후 일정`);

    return [{
      ruleCode: 'R10',
      ruleVersion: R10_VERSION,
      severity: 'WARNING',
      reasonCode: 'TARGET_MISMATCH',
      // 상품 단위 판정이라 지목할 항목이 없다
      targetItemId: null,
      message:
        `${TARGET_LABEL[profile.targetKey]} · ${CONCEPT_LABEL[profile.conceptKey]} 상품인데 ` +
        `${labels.join(', ')}이(가) 일정에 없습니다.`,
      evidence: {
        targetKey: profile.targetKey,
        conceptKey: profile.conceptKey,
        expectedLcls2: [...profile.expectedLcls2],
        missingLcls2: missing,
        expectsNight: profile.expectsNight,
        hasNight: summary.hasNight,
        nightSlotFrom: RULE_CONSTANTS.R10_NIGHT_SLOT_FROM,
        // FR-RU-101 집계. 화면이 「무엇으로 채워져 있는가」를 보여줄 때 쓴다
        lcls2Counts: Object.fromEntries(summary.byLcls2),
        lcls3Counts: Object.fromEntries(summary.byLcls3),
        contentTypeCounts: Object.fromEntries(summary.byContentType),
        judgedCount: items.length,
      },
      requiresExternal: false,
      externalSource: null,
      needsConfirmation: false,
    }];
  }
}
