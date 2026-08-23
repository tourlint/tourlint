import type { ItineraryItemRow } from './audit-runner';
import { applyPatches, orderPatches } from './patch-apply';
import { selectionKey, type SelectedPatch } from './patch-types';

/**
 * 확정 전 수정안 충돌 검사 (FR-PA-005 ~ 007).
 *
 * 검사 셋 —
 * ① 같은 일정 항목을 두 수정안이 동시에 변경하는가
 * ② 반영 후 같은 시간대에 둘 이상이 배치되는가
 * ③ 반영 순서에 따라 결과가 달라지는가
 *
 * **충돌이 있으면 확정을 막고 쌍을 명시한다.** 시스템이 임의로 수정안을 해제하지 않는다
 * (`FR-PA-006`) — 어느 쪽을 살릴지는 사용자만 안다. 하나를 골라 주면 사용자는 자기가
 * 고르지 않은 변경을 반영하게 된다.
 */

export const CONFLICT_KIND = ['SAME_ITEM', 'TIME_OVERLAP', 'ORDER_DEPENDENT'] as const;
export type ConflictKind = (typeof CONFLICT_KIND)[number];

/** 수정안 하나를 가리키는 참조. API 계약이 이 모양이다 */
export interface PatchRef {
  readonly findingId: number;
  readonly patchId: string;
}

export interface Conflict {
  readonly kind: ConflictKind;
  /** 충돌하는 수정안 쌍 (FR-PA-006). 선택 키 오름차순이다 */
  readonly a: PatchRef;
  readonly b: PatchRef;
  readonly message: string;
}

export interface ConflictReport {
  readonly hasConflict: boolean;
  readonly conflicts: readonly Conflict[];
}

export function checkConflicts(
  items: readonly ItineraryItemRow[],
  patches: readonly SelectedPatch[],
): ConflictReport {
  const conflicts: Conflict[] = [
    ...sameItemConflicts(patches),
    ...timeOverlapConflicts(items, patches),
    ...orderDependentConflicts(items, patches),
  ];

  // 같은 쌍이 여러 이유로 걸리면 한 번만 말한다. 사용자가 볼 건 "이 둘은 같이 못 쓴다" 다
  const seen = new Set<string>();
  const unique = conflicts.filter((c) => {
    const key = `${selectionKey(c.a)}|${selectionKey(c.b)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { hasConflict: unique.length > 0, conflicts: unique };
}

/** ① 같은 항목을 두 수정안이 건드린다 */
function sameItemConflicts(patches: readonly SelectedPatch[]): readonly Conflict[] {
  const out: Conflict[] = [];
  const ordered = orderPatches(patches);

  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i];
      const b = ordered[j];
      if (a === undefined || b === undefined) continue;
      if (!touches(a).some((id) => touches(b).includes(id))) continue;
      out.push({
        kind: 'SAME_ITEM',
        ...pair(a, b),
        message: '같은 일정 항목을 두 수정안이 함께 바꿉니다. 하나만 선택해 주세요.',
      });
    }
  }
  return out;
}

/**
 * 이 수정안이 건드리는 항목 id 들.
 *
 * `REORDER` 는 상대 항목까지 바꾼다. 대상만 보면 "A↔B 교체" 와 "B 시각 이동" 이 서로
 * 다른 항목을 건드리는 것처럼 보여 충돌을 놓친다.
 */
function touches(patch: SelectedPatch): readonly number[] {
  if (patch.type === 'REORDER') {
    const other = (patch.payload as { swapWithItemId: number }).swapWithItemId;
    return [patch.targetItemId, other];
  }
  // INSERT_ITEM 의 대상은 기준점일 뿐 바뀌지 않는다
  if (patch.type === 'INSERT_ITEM') return [];
  return [patch.targetItemId];
}

/** ② 다 반영하고 나니 같은 시간대에 둘 이상이 있다 */
function timeOverlapConflicts(
  items: readonly ItineraryItemRow[],
  patches: readonly SelectedPatch[],
): readonly Conflict[] {
  if (patches.length < 2) return [];

  const before = overlapKeys(items);
  const result = applyPatches(items, patches);
  const after = overlapKeys(result.items);

  /*
   * 원래도 겹쳐 있던 쌍은 여기서 말하지 않는다. 그건 R03 이 이미 지적한 결함이고,
   * 수정안끼리의 충돌이 아니다. 새로 생긴 겹침만 확정을 막는다.
   */
  const created = [...after].filter((k) => !before.has(k));
  if (created.length === 0) return [];

  const out: Conflict[] = [];
  for (const key of created) {
    const ids = key.split('|').map(Number);
    // 삽입 항목은 `touches` 에 안 잡힌다. 어느 수정안이 넣었는지는 반영 결과가 안다
    const responsible = patches.filter((p) =>
      ids.some((id) => touches(p).includes(id) || result.insertedBy.get(id) === selectionKey(p)),
    );
    if (responsible.length < 2) continue;
    const [a, b] = responsible;
    if (a === undefined || b === undefined) continue;
    out.push({
      kind: 'TIME_OVERLAP',
      ...pair(a, b),
      message: '두 수정안을 함께 반영하면 같은 시간대에 일정이 겹칩니다.',
    });
  }
  return out;
}

/** 겹치는 항목 쌍의 키. 일차가 다르면 겹치지 않는다 */
function overlapKeys(items: readonly ItineraryItemRow[]): Set<string> {
  const keys = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (a === undefined || b === undefined) continue;
      if (a.dayNo !== b.dayNo) continue;
      if (a.endTime === null || b.endTime === null) continue;
      if (a.startTime < b.endTime && b.startTime < a.endTime) {
        keys.add([a.id, b.id].sort((x, y) => x - y).join('|'));
      }
    }
  }
  return keys;
}

/**
 * ③ 순서를 바꾸면 결과가 달라진다.
 *
 * **쌍마다 확인한다.** 전체를 한 번 뒤집어 보는 방식은 어느 둘이 문제인지 못 짚어,
 * `FR-PA-006` 이 요구하는 "충돌하는 수정안 쌍 명시" 를 못 한다. 수정안은 많아야 열댓 개라
 * 쌍마다 반영해 보는 비용이 문제되지 않는다.
 *
 * **오늘의 설계에서 이 검사는 ① 에 거의 흡수된다.** 반영이 그때그때의 상태에만 기대므로,
 * 순서가 결과를 가르려면 두 수정안이 같은 항목을 건드려야 하고 그건 ① 이 먼저 잡는다.
 * 그래도 남겨 둔다 — 반영 로직이 상태 밖의 것에 기대기 시작하면 그때는 ① 이 못 잡는다.
 */
export function orderDependentConflicts(
  items: readonly ItineraryItemRow[],
  patches: readonly SelectedPatch[],
): readonly Conflict[] {
  if (patches.length < 2) return [];

  const ordered = orderPatches(patches);
  const out: Conflict[] = [];

  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i];
      const b = ordered[j];
      if (a === undefined || b === undefined) continue;
      /*
       * `applyPatches` 는 평소 자기가 정한 순서로 다시 정렬한다. 그대로 두면 뒤집어 넣어도
       * 같은 순서로 돌아 이 검사가 항상 "충돌 없음" 을 말한다 — `preserveOrder` 로 막는다.
       */
      const forward = applyPatches(items, [a, b], { preserveOrder: true });
      const backward = applyPatches(items, [b, a], { preserveOrder: true });
      if (shape(forward.items) === shape(backward.items)) continue;
      out.push({
        kind: 'ORDER_DEPENDENT',
        ...pair(a, b),
        message: '반영 순서에 따라 결과가 달라집니다. 하나씩 나눠 반영해 주세요.',
      });
    }
  }
  return out;
}

/** 비교용 모양. id 순으로 정렬해 배열 순서 차이는 무시하고 값 차이만 본다 */
function shape(items: readonly ItineraryItemRow[]): string {
  return JSON.stringify(
    [...items]
      .sort((a, b) => a.id - b.id)
      .map((i) => [i.id, i.dayNo, i.seq, i.startTime, i.endTime, i.ktoContentId]),
  );
}

/** 쌍의 순서를 못박는다. 같은 충돌이 실행마다 다른 순서로 나오면 비교가 안 된다 */
function pair(a: SelectedPatch, b: SelectedPatch): { a: PatchRef; b: PatchRef } {
  const ref = (p: SelectedPatch): PatchRef => ({ findingId: p.findingId, patchId: p.patchId });
  return selectionKey(a) <= selectionKey(b) ? { a: ref(a), b: ref(b) } : { a: ref(b), b: ref(a) };
}
