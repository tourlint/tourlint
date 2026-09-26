import { LCLS_SYSTM2, PLAN_BASE_LCLS2 } from '@tourlint/shared';
import type { Finding, ProductDetail } from '../../../lib/api';
import type { PickerContext } from './plan/place-picker';

export function placeAction(rule: string): string | null {
  return rule === 'R07' ? '식당·카페 찾기' : rule === 'R10' ? '부족한 장소 채우기' : rule === 'R04' ? '다른 즐길 거리 찾기' : null;
}

/**
 * 장소 담기 기본 종류가 대개 어느 관광 유형(contentTypeId)으로 오는가. 픽스처 실측으로 전시시설만
 * 문화시설(14)이고 나머지는 관광지(12)다. R04 가 관광 유형으로 쏠렸을 때 다른 유형을 고르는 데만 쓴다.
 */
const BASE_CONTENT_TYPE: Readonly<Record<string, string>> = { VE01: '12', NA02: '12', VE07: '14', EX02: '12' };

/**
 * R04 — 반복된 종류를 뺀 장소 담기 기본 종류 (UI-S3-028). 소분류로 쏠렸으면 그 중분류를, 관광 유형으로
 * 쏠렸으면 그 유형으로 오는 종류를 뺀다. 첫째를 골라 열고 사람이 바꿀 수 있다.
 */
export function otherSightTypes(verdict: Record<string, unknown> | undefined): string[] {
  const key = typeof verdict?.key === 'string' ? verdict.key : null;
  if (key === null) return [];
  return PLAN_BASE_LCLS2.filter((code) => (verdict?.axis === 'lclsSystm3' ? !key.startsWith(code) : BASE_CONTENT_TYPE[code] !== key));
}

export function reviewPlaceContext(product: ProductDetail, finding?: Finding): PickerContext {
  const verdict = finding?.evidenceView?.verdict as Record<string, unknown> | undefined;
  const day = product.days.find(d => d.day === verdict?.dayNo) ?? product.days[0];
  const candidates = (day?.items ?? []).filter(it => it.matchStatus === 'CONFIRMED' && it.mapx !== null && it.mapy !== null);
  const anchor = finding?.ruleCode === 'R07'
    ? candidates.filter(it => it.end !== null && it.end <= '14:00').at(-1) ?? candidates[0]
    : candidates[0];
  const suggestedTypes = finding?.ruleCode === 'R04' ? otherSightTypes(verdict)
    : Array.isArray(verdict?.missingLcls2)
      ? verdict.missingLcls2.filter((code): code is string => typeof code === 'string' && !!LCLS_SYSTM2[code]) : [];
  return {
    initialDay: day?.day ?? 1,
    initialAnchorId: anchor?.itemId ?? null,
    initialNearKind: finding?.ruleCode === 'R07' && anchor ? 'MEAL' : null,
    openType: suggestedTypes[0] ?? null,
    suggestedTypes,
  };
}
