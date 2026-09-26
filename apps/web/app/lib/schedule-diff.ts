/**
 * 편집한 일정을 서버 호출로 옮기는 **비교 계산** (FR-IN-014).
 *
 * 무엇을 지우고 무엇을 새로 넣을지가 틀리면 일정이 소리 없이 망가진다. 순수 함수로 두고
 * 테스트로 잡는다.
 */

import type { InputItemOrigin } from '@tourlint/shared';
import type { MatchedContent, ScheduleItem } from '../(app)/products/new/types';

export interface EditedItem {
  /** 서버 항목 id. 새로 추가한 항목은 없다 */
  readonly itemId?: number;
  /**
   * 고른 관광지 (#665). 새 항목이면 확정 상태로 넣어야 하므로 저장할 때 다른 호출로 나간다.
   * 불러온 줄에서 고른 곳은 `placeCalls` 가 다룬다. 견주기(`changedFields`)는 이 값을 보지 않는다.
   */
  readonly content?: MatchedContent | null;
  /** 새 항목이 들어온 경로 (FR-PL-020). 견주기는 이 값을 보지 않는다 */
  readonly origin?: InputItemOrigin;
  /** 「직접 정한 곳으로 두기」를 고른 줄 (UI-S2-021). 견주기는 이 값을 보지 않는다 — 저장이 따로 부른다 */
  readonly excluded?: boolean;
  /** 걷기 길 (UI-S2-048). 새 항목이면 걷기 길 추가로 넣는다. 견주기는 이 값을 보지 않는다 */
  readonly walkId?: string;
  readonly dayNo: number;
  readonly seq: number;
  readonly startTime: string;
  readonly endTime: string;
  readonly placeLabel: string;
  readonly itemType: string;
}

export interface ItemPatch {
  readonly itemId: number;
  readonly patch: Partial<Pick<EditedItem, 'startTime' | 'endTime' | 'placeLabel' | 'itemType'>>;
}

export interface SchedulePlan {
  readonly removed: readonly number[];
  readonly added: readonly EditedItem[];
  readonly patched: readonly ItemPatch[];
  /**
   * 자리를 다시 매겨야 하는가. `PUT .../order` 는 **그 상품의 모든 항목**을 요구하므로
   * (`validateOrder` — 하나라도 빠지면 400) 새로 추가한 항목의 id 를 받은 뒤에 보낸다.
   */
  readonly needsOrder: boolean;
  /** 원하는 최종 순서. `itemId` 가 없는 항목은 추가한 뒤 받은 id 로 채운다 */
  readonly order: readonly EditedItem[];
}

/** 값이 바뀐 필드만 담는다 — 안 바뀐 것을 보내면 서버가 같은 값을 다시 쓴다 */
function changedFields(before: EditedItem, after: EditedItem): ItemPatch['patch'] {
  const patch: Record<string, string> = {};
  if (before.startTime !== after.startTime) patch.startTime = after.startTime;
  if (before.endTime !== after.endTime) patch.endTime = after.endTime;
  if (before.placeLabel !== after.placeLabel) patch.placeLabel = after.placeLabel;
  if (before.itemType !== after.itemType) patch.itemType = after.itemType;
  return patch;
}

/**
 * 편집 전후를 견주어 낼 호출을 정한다.
 *
 * 순서 변경은 **자리가 실제로 달라졌을 때만** 낸다. 항목을 하나도 안 옮겼는데 매번
 * `PUT .../order` 를 보내면 트랜잭션이 헛돈다.
 */
export function planSchedule(before: readonly EditedItem[], after: readonly EditedItem[]): SchedulePlan {
  const beforeById = new Map(before.filter((i) => i.itemId !== undefined).map((i) => [i.itemId as number, i]));
  const keptIds = new Set(after.filter((i) => i.itemId !== undefined).map((i) => i.itemId as number));

  const removed = [...beforeById.keys()].filter((id) => !keptIds.has(id));
  const added = after.filter((i) => i.itemId === undefined);

  const patched: ItemPatch[] = [];
  let moved = false;

  for (const item of after) {
    if (item.itemId === undefined) continue;
    const was = beforeById.get(item.itemId);
    if (was === undefined) continue;
    const patch = changedFields(was, item);
    if (Object.keys(patch).length > 0) patched.push({ itemId: item.itemId, patch });
    if (was.dayNo !== item.dayNo || was.seq !== item.seq) moved = true;
  }

  // 추가·삭제가 있으면 자리는 어차피 다시 매겨야 한다
  const needsOrder = moved || removed.length > 0 || added.length > 0;
  return { removed, added, patched, needsOrder, order: needsOrder ? after : [] };
}

/** 아무것도 안 바뀌었으면 저장 버튼을 눌러도 호출이 없어야 한다 */
export function isEmptyPlan(plan: SchedulePlan): boolean {
  return plan.removed.length === 0 && plan.added.length === 0
    && plan.patched.length === 0 && !plan.needsOrder;
}

/** 불러온 줄의 장소 상태를 바꾸는 호출. 순서 · 시각 비교(`planSchedule`)와 따로 낸다 */
export interface PlaceCalls {
  /** 고르는 중이던 줄을 직접 정한 곳으로 (UI-S2-021) */
  readonly exclude: readonly number[];
  /** 새로 고른 곳으로 확정한다 — 사람이 고른 것이다 (FR-IN-029) */
  readonly match: readonly { readonly itemId: number; readonly contentId: string }[];
}

/**
 * 불러온 줄에서 바꾼 장소 상태를 호출로 옮긴다. 장소만 바꿨으면 비교는 빈 계획이라 따로 센다.
 *
 * 줄 이름은 여기서 다루지 않는다 — 불러온 줄은 골라도 이름이 친 글 그대로라(`keepName`) 바꿔 쳤을
 * 때만 비교가 `PATCH` 를 낸다 (DR-PR-001). 저장된 곳과 같은 곳을 다시 고른 줄(기준으로 쓰려고
 * 확인한 줄)은 부르지 않는다. 걷기 길은 확정할 수 없는 줄이다.
 */
export function placeCalls(items: readonly ScheduleItem[]): PlaceCalls {
  const exclude: number[] = [];
  const match: { itemId: number; contentId: string }[] = [];
  for (const it of items) {
    if (it.itemId === undefined || it.saved === undefined || it.walk !== undefined) continue;
    // 고른 곳이 있으면 직접 정한 곳으로 보내지 않는다 — 후보를 확인하는 사이 둘 다 걸릴 수 있다
    if (it.excluded === true && !it.content && it.saved.matchStatus === 'PENDING') exclude.push(it.itemId);
    if (it.content && it.content.contentId !== it.saved.contentId) {
      match.push({ itemId: it.itemId, contentId: it.content.contentId });
    }
  }
  return { exclude, match };
}
