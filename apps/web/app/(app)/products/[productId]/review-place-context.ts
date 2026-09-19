import { LCLS_SYSTM2 } from '@tourlint/shared';
import type { Finding, ProductDetail } from '../../../lib/api';
import type { PickerContext } from './plan/place-picker';

export function placeAction(rule: string): string | null {
  return rule === 'R07' ? '식당·카페 찾기' : rule === 'R10' ? '부족한 장소 채우기' : rule === 'R04' ? '다른 즐길 거리 찾기' : null;
}

export function reviewPlaceContext(product: ProductDetail, finding?: Finding): PickerContext {
  const verdict = finding?.evidenceView?.verdict as Record<string, unknown> | undefined;
  const day = product.days.find(d => d.day === verdict?.dayNo) ?? product.days[0];
  const candidates = (day?.items ?? []).filter(it => it.matchStatus === 'CONFIRMED' && it.mapx !== null && it.mapy !== null);
  const anchor = finding?.ruleCode === 'R07'
    ? candidates.filter(it => it.end !== null && it.end <= '14:00').at(-1) ?? candidates[0]
    : candidates[0];
  const suggestedTypes = Array.isArray(verdict?.missingLcls2)
    ? verdict.missingLcls2.filter((code): code is string => typeof code === 'string' && !!LCLS_SYSTM2[code]) : [];
  return {
    initialDay: day?.day ?? 1,
    initialAnchorId: anchor?.itemId ?? null,
    initialNearKind: finding?.ruleCode === 'R07' && anchor ? 'MEAL' : null,
    openType: suggestedTypes[0] ?? null,
    suggestedTypes,
  };
}
