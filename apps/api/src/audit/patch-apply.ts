import type { ItineraryItemRow } from './audit-runner';
import {
  selectionKey,
  type InsertItemPayload,
  type PatchType,
  type ReorderPayload,
  type ReplaceContentPayload,
  type SelectedPatch,
  type TimeShiftPayload,
} from './patch-types';

/**
 * 선택된 수정안을 일정표에 반영한다 (FR-PA-020).
 *
 * **순수 함수다.** 같은 일정표에 같은 수정안 묶음을 넣으면 언제나 같은 결과가 나온다.
 * DB 를 쓰기 전에 결과를 미리 볼 수 있어야 하고(F08 대조 표시 · FR-PA-004), 충돌 검사도
 * "반영해 보고 겹치는지" 로 답해야 정확하다.
 *
 * ## 반영 순서가 정해져 있는 이유
 *
 * `FR-PA-020` 이 "정해진 순서로" 라고만 적었지 순서를 말하지 않는다. 여기서 정한다.
 *
 * 1. `REMOVE_ITEM` — 빠질 것을 먼저 뺀다. 뒤 단계가 없는 항목을 붙들지 않는다
 * 2. `REPLACE_CONTENT` — 자리는 그대로 두고 내용만 바꾼다
 * 3. `TIME_SHIFT` — 시각과 일차를 옮긴다
 * 4. `REORDER` — 옮겨진 시각 위에서 순서를 맞춘다
 * 5. `INSERT_ITEM` — 마지막에 넣는다. 앞 단계가 만든 빈 시간에 들어가야 한다
 *
 * 순서를 바꾸면 결과가 달라진다. 예를 들어 `INSERT_ITEM` 을 먼저 하면 뒤이은
 * `TIME_SHIFT` 가 방금 넣은 항목을 밟고 지나간다. 그래서 **순서 의존성 자체를 충돌로
 * 보고 미리 막는다** (`patch-conflict.ts` 의 세 번째 검사).
 */

const APPLY_ORDER: readonly PatchType[] = [
  'REMOVE_ITEM',
  'REPLACE_CONTENT',
  'TIME_SHIFT',
  'REORDER',
  'INSERT_ITEM',
];

/** 새로 넣은 항목의 임시 id. 저장 시점에 실제 id 로 바뀐다 */
export const INSERTED_ID_BASE = -1;

export interface ApplyResult {
  readonly items: readonly ItineraryItemRow[];
  /** 반영된 수정안의 선택 키(`findingId:patchId`). 대상이 없어져 못 넣은 것은 빠진다 */
  readonly applied: readonly string[];
  /** 대상이 사라져 반영하지 못한 수정안. 조용히 삼키지 않는다 */
  readonly skipped: readonly { readonly patchId: string; readonly reason: string }[];
  /** 새로 넣은 항목의 임시 id → 그걸 넣은 수정안. 충돌 검사가 책임 소재를 찾는 데 쓴다 */
  readonly insertedBy: ReadonlyMap<number, string>;
}

export interface ApplyOptions {
  /**
   * 준 순서 그대로 반영한다. **충돌 검사 전용이다** (`FR-PA-005` ③).
   *
   * 평소에는 `orderPatches` 가 정한 순서로 돌아야 결과가 결정론적이다. 순서 의존성을
   * 보려면 일부러 다른 순서로 돌려 봐야 해서 문을 하나 열어 둔다.
   */
  readonly preserveOrder?: boolean;
}

/**
 * 새로 넣을 항목의 임시 id 를 미리 정한다.
 *
 * 넣는 차례대로 −1, −2 를 매기면 **반영 순서가 바뀔 때 id 도 바뀐다.** 그러면 순서
 * 의존성 검사가 실제로는 같은 결과인데 다르다고 말한다. `patchId` 로 정렬해 못박는다.
 */
function reserveInsertIds(patches: readonly SelectedPatch[]): Map<string, number> {
  const ids = new Map<string, number>();
  patches
    .filter((p) => p.type === 'INSERT_ITEM')
    .map(selectionKey)
    .sort((a, b) => a.localeCompare(b))
    .forEach((key, i) => ids.set(key, INSERTED_ID_BASE * (i + 1)));
  return ids;
}

/** 정해진 순서로 정렬한다. 같은 유형끼리는 대상 항목 id 순 — 입력 순서에 기대지 않는다 */
export function orderPatches(patches: readonly SelectedPatch[]): readonly SelectedPatch[] {
  return [...patches].sort((a, b) => {
    const byType = APPLY_ORDER.indexOf(a.type) - APPLY_ORDER.indexOf(b.type);
    if (byType !== 0) return byType;
    if (a.targetItemId !== b.targetItemId) return a.targetItemId - b.targetItemId;
    return selectionKey(a).localeCompare(selectionKey(b));
  });
}

export function applyPatches(
  items: readonly ItineraryItemRow[],
  patches: readonly SelectedPatch[],
  options: ApplyOptions = {},
): ApplyResult {
  let working = items.map((i) => ({ ...i }));
  const applied: string[] = [];
  const skipped: { patchId: string; reason: string }[] = [];
  const insertIds = reserveInsertIds(patches);
  const insertedBy = new Map<number, string>();

  for (const patch of options.preserveOrder === true ? patches : orderPatches(patches)) {
    const index = working.findIndex((i) => i.id === patch.targetItemId);

    // INSERT_ITEM 은 대상 항목을 지우는 게 아니라 기준점으로만 쓴다
    if (index === -1 && patch.type !== 'INSERT_ITEM') {
      skipped.push({ patchId: selectionKey(patch), reason: '대상 일정이 이미 없습니다' });
      continue;
    }

    switch (patch.type) {
      case 'REMOVE_ITEM':
        working.splice(index, 1);
        break;

      case 'REPLACE_CONTENT': {
        const p = patch.payload as ReplaceContentPayload;
        const target = working[index];
        if (target === undefined) break;
        /*
         * `placeLabel` 은 그대로 둔다. 대체 관광지의 명칭은 공사 원문이라 저장할 수 없다
         * (DR-PR-001). 화면은 `ktoContentId` 로 실시간 조회해 이름을 보여준다.
         */
        working[index] = {
          ...target,
          ktoContentId: p.ktoContentId,
          contentTypeId: p.contentTypeId,
          lclsSystm2: p.lclsSystm2,
          mapX: p.mapx,
          mapY: p.mapy,
          matchStatus: 'CONFIRMED',
        };
        break;
      }

      case 'TIME_SHIFT': {
        const p = patch.payload as TimeShiftPayload;
        const target = working[index];
        if (target === undefined) break;
        working[index] = {
          ...target,
          dayNo: p.newDayNo ?? target.dayNo,
          startTime: p.newStartTime ?? target.startTime,
          endTime: p.newEndTime ?? target.endTime,
          // 시각을 사람이 정했으므로 체류시간 보완값이 아니다 (FR-RU-031)
          endTimeSource: p.newEndTime === undefined ? target.endTimeSource : 'INPUT',
        };
        break;
      }

      case 'REORDER': {
        const p = patch.payload as ReorderPayload;
        const other = working.findIndex((i) => i.id === p.swapWithItemId);
        if (other === -1) {
          skipped.push({ patchId: selectionKey(patch), reason: '바꿀 상대 일정이 이미 없습니다' });
          continue;
        }
        const a = working[index];
        const b = working[other];
        if (a === undefined || b === undefined) break;
        /*
         * 순서(`seq`)와 시각을 함께 바꾼다. `seq` 만 바꾸면 시각은 그대로라 화면에서
         * 순서와 시각이 어긋난다 — 두 항목이 자리를 맞바꾸는 것이 사용자가 기대하는 동작이다.
         */
        working[index] = { ...a, seq: b.seq, startTime: b.startTime, endTime: b.endTime };
        working[other] = { ...b, seq: a.seq, startTime: a.startTime, endTime: a.endTime };
        break;
      }

      case 'INSERT_ITEM': {
        const p = patch.payload as InsertItemPayload;
        const insertedId = insertIds.get(selectionKey(patch)) ?? INSERTED_ID_BASE;
        insertedBy.set(insertedId, selectionKey(patch));
        const inserted: ItineraryItemRow = {
          id: insertedId,
          dayNo: p.dayNo,
          seq: 0,
          startTime: p.startTime,
          endTime: p.endTime,
          endTimeSource: 'INPUT',
          // 사용자가 입력한 문구가 아직 없다. 화면이 유형으로 안내한다
          placeLabel: '',
          itemType: p.itemType,
          ktoContentId: null,
          contentTypeId: null,
          lclsSystm1: null,
          lclsSystm2: null,
          lclsSystm3: null,
          mapX: null,
          mapY: null,
          matchStatus: 'PENDING',
        };
        working.push(inserted);
        break;
      }
    }
    applied.push(selectionKey(patch));
  }

  working = resequence(working);
  return { items: working, applied, skipped, insertedBy };
}

/**
 * 일차별로 시각 순으로 `seq` 를 다시 매긴다.
 *
 * 항목을 넣고 빼고 옮기면 `seq` 에 구멍이 나거나 시각과 어긋난다. R03 겹침 · R07 연속시간 ·
 * R08 구간이 모두 `seq` 순서를 전제하므로 여기서 정리하지 않으면 재검수가 엉뚱해진다.
 */
function resequence(items: readonly ItineraryItemRow[]): ItineraryItemRow[] {
  const byDay = new Map<number, ItineraryItemRow[]>();
  for (const item of items) {
    const bucket = byDay.get(item.dayNo);
    if (bucket === undefined) byDay.set(item.dayNo, [item]);
    else bucket.push(item);
  }

  const out: ItineraryItemRow[] = [];
  for (const [, dayItems] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    dayItems
      .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.seq - b.seq || a.id - b.id)
      .forEach((item, i) => out.push({ ...item, seq: i + 1 }));
  }
  return out;
}
