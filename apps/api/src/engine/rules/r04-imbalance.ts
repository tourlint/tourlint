import { type Severity } from '@tourlint/shared';
import type { AuditItem, AuditRule, AuditSettings, Finding, ItineraryContext } from './types';

/**
 * R04 — 콘텐츠 편중 (FR-RU-040 ~ 043).
 *
 * 같은 유형만 반복되는 일정은 손님이 지루해한다. 박물관 네 곳을 붙여 놓은 코스 같은 것이다.
 *
 * **집계 대상은 일정 항목 유형이 `관광`인 항목뿐이다.** 2박 3일 상품은 식사만 최소 3회라
 * 제외하지 않으면 정상 일정에도 R04 가 상시 발동한다 (2026.08.20 TP-01 검증).
 * 이 한 줄이 이 규칙에서 가장 중요하다.
 *
 * 축이 둘이고 범위가 둘이다 — `contentTypeId` · 신분류체계 소분류를 각각
 * 일차 단위와 상품 전체 단위로 센다.
 */

export const R04_VERSION = '1.0.0';

/** 집계 축 */
export type ImbalanceAxis = 'contentTypeId' | 'lclsSystm3';
/** 집계 범위 */
export type ImbalanceScope = 'DAY' | 'PRODUCT';

export interface ImbalanceGroup {
  readonly axis: ImbalanceAxis;
  readonly scope: ImbalanceScope;
  /** `DAY` 면 일차 번호, `PRODUCT` 면 null */
  readonly dayNo: number | null;
  readonly key: string;
  readonly count: number;
  readonly itemIds: readonly number[];
}

/** 관광 항목만 센다 (FR-RU-040) */
export function countableItems(items: readonly AuditItem[]): readonly AuditItem[] {
  return items.filter((i) => i.itemType === 'SIGHT');
}

/**
 * 임계치 이상 반복되는 묶음을 찾는다.
 *
 * 같은 축·같은 키가 일차와 상품 양쪽에서 동시에 걸릴 수 있다. 그때는 **상품 단위만 남긴다** —
 * 같은 반복을 두 번 지적하면 감점이 두 배가 되고 사용자는 문제가 둘인 줄 안다.
 */
export function findImbalances(
  items: readonly AuditItem[],
  settings: AuditSettings,
): readonly ImbalanceGroup[] {
  const countable = countableItems(items);
  const excluded = new Set(settings.r04ExcludedKeys);
  const out: ImbalanceGroup[] = [];

  for (const axis of ['contentTypeId', 'lclsSystm3'] as const) {
    // 상품 전체
    const product = tally(countable, axis, excluded);
    const hit = new Set<string>();
    for (const [key, ids] of product) {
      if (ids.length < settings.r04Threshold) continue;
      hit.add(key);
      out.push({ axis, scope: 'PRODUCT', dayNo: null, key, count: ids.length, itemIds: ids });
    }

    // 일차 단위 — 상품 단위에서 이미 잡힌 키는 다시 세지 않는다
    for (const [dayNo, dayItems] of groupByDay(countable)) {
      for (const [key, ids] of tally(dayItems, axis, excluded)) {
        if (hit.has(key) || ids.length < settings.r04Threshold) continue;
        out.push({ axis, scope: 'DAY', dayNo, key, count: ids.length, itemIds: ids });
      }
    }
  }

  // 출력 순서를 고정한다 (NF-MT-001)
  return [...out].sort(
    (a, b) =>
      a.axis.localeCompare(b.axis) ||
      a.scope.localeCompare(b.scope) ||
      (a.dayNo ?? 0) - (b.dayNo ?? 0) ||
      a.key.localeCompare(b.key),
  );
}

function tally(
  items: readonly AuditItem[],
  axis: ImbalanceAxis,
  excluded: ReadonlySet<string>,
): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const item of items) {
    const key = axis === 'contentTypeId'
      ? (item.content === null ? null : String(item.content.contentTypeId))
      : item.lclsSystm3;
    // 분류를 모르는 항목은 세지 않는다. 모르는 것끼리 묶으면 없는 편중이 만들어진다
    if (key === null || key === '') continue;
    if (excluded.has(key)) continue;
    const bucket = map.get(key);
    if (bucket === undefined) map.set(key, [item.id]);
    else bucket.push(item.id);
  }
  return map;
}

function groupByDay(items: readonly AuditItem[]): Map<number, AuditItem[]> {
  const map = new Map<number, AuditItem[]>();
  for (const item of items) {
    const bucket = map.get(item.dayNo);
    if (bucket === undefined) map.set(item.dayNo, [item]);
    else bucket.push(item);
  }
  return new Map([...map.entries()].sort((a, b) => a[0] - b[0]));
}

export class R04ImbalanceRule implements AuditRule {
  readonly code = 'R04';
  readonly version = R04_VERSION;
  readonly defaultSeverity: Severity = 'WARNING';
  readonly requiresExternal = false;

  evaluate(ctx: ItineraryContext): readonly Finding[] {
    return findImbalances(ctx.items, ctx.settings).map((g) => ({
      ruleCode: 'R04',
      ruleVersion: R04_VERSION,
      severity: 'WARNING' as const,
      reasonCode: 'CONTENT_IMBALANCE' as const,
      // 상품·일차 단위 판정이라 지목할 항목이 하나가 아니다. 대상은 evidence 에 전부 담는다
      targetItemId: null,
      message: message(g, ctx.settings),
      evidence: {
        axis: g.axis, scope: g.scope, dayNo: g.dayNo, key: g.key,
        count: g.count, itemIds: g.itemIds, threshold: ctx.settings.r04Threshold,
      },
      requiresExternal: false,
      externalSource: null,
      needsConfirmation: false,
    }));
  }
}

const AXIS_LABEL: Readonly<Record<ImbalanceAxis, string>> = {
  contentTypeId: '같은 관광 유형',
  lclsSystm3: '같은 소분류',
};

function message(g: ImbalanceGroup, settings: AuditSettings): string {
  const where = g.scope === 'PRODUCT' ? '상품 전체' : `${g.dayNo}일차`;
  return (
    `${where}에 ${AXIS_LABEL[g.axis]}(${g.key})이 ${g.count}곳입니다. ` +
    `기준 ${settings.r04Threshold}곳 이상이라 일정이 한쪽으로 쏠려 있습니다. 한 곳을 다른 유형으로 바꿔 보세요.`
  );
}
