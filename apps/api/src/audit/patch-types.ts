import type { ContentTypeId, ParseConfidence } from '@tourlint/shared';

/**
 * 수정안 (DB 명세서 4-3 · FR-PA-001 ~ 010).
 *
 * ⚠️ **표시 문구(`label`)를 담지 않는다.**
 *
 * `REPLACE_CONTENT` 의 대체 관광지는 사용자가 입력한 장소가 아니라 `locationBasedList2` 로
 * 찾아온 콘텐츠라 그 명칭은 **공사 원문**이다. `"선교장으로 대체"` 같은 문구를 저장하면
 * 명칭 저장이 된다 (DR-PR-001 위반). 구조화된 `type` 과 `payload` 만 담고 문구는
 * **표시 시점에 조합**한다 — `REPLACE_CONTENT` 는 `payload.ktoContentId` 로 실시간 조회,
 * 나머지는 `itinerary_item.place_label` 로 만든다 (0콜).
 */

export const PATCH_TYPE = ['TIME_SHIFT', 'REORDER', 'REPLACE_CONTENT', 'INSERT_ITEM', 'REMOVE_ITEM'] as const;
export type PatchType = (typeof PATCH_TYPE)[number];

/** finding 1건당 최대 3개 (FR-PA-002 · `ck_finding_patch_max`) */
export const MAX_PATCHES_PER_FINDING = 3;

export interface ReplaceContentPayload {
  readonly ktoContentId: string;
  readonly contentTypeId: ContentTypeId;
  readonly lclsSystm2: string | null;
  readonly mapx: number | null;
  readonly mapy: number | null;
  readonly distanceMeters: number;
  readonly parseConfidence: ParseConfidence | null;
}

export interface TimeShiftPayload {
  readonly newDayNo?: number;
  readonly newStartTime?: string;
  readonly newEndTime?: string;
}

export interface ReorderPayload {
  readonly swapWithItemId: number;
}

export interface InsertItemPayload {
  readonly dayNo: number;
  readonly afterItemId: number | null;
  readonly startTime: string;
  readonly endTime: string;
  readonly itemType: 'MEAL' | 'REST' | 'SIGHT';
  /**
   * 넣을 관광지 (선택).
   *
   * R07 식사 삽입은 자리만 만들면 되지만 R09 · R10 은 **무엇을** 넣을지가 제안의 전부다 —
   * 「빈 시간에 실내 관광지를 넣으세요」로는 사용자가 할 일이 안 준다 (FR-RU-093 · 103).
   *
   * ⚠️ 명칭은 담지 않는다. 대체 관광지와 같은 이유다 — 공사 원문이라 표시할 때 조회한다.
   */
  readonly content?: {
    readonly ktoContentId: string;
    readonly contentTypeId: ContentTypeId;
    readonly lclsSystm2: string | null;
    readonly mapx: number | null;
    readonly mapy: number | null;
  };
}

export type RemoveItemPayload = Record<string, never>;

export type PatchPayload =
  | ReplaceContentPayload
  | TimeShiftPayload
  | ReorderPayload
  | InsertItemPayload
  | RemoveItemPayload;

export interface Patch {
  /** finding 안에서만 유일하면 된다. `p-1` · `p-2` · `p-3` */
  readonly patchId: string;
  readonly type: PatchType;
  readonly targetItemId: number;
  readonly payload: PatchPayload;
}

/** 규칙별 수정안이 몇 개 붙었는지 세는 용도 */
export function patchId(index: number): string {
  return `p-${index + 1}`;
}

/**
 * 사용자가 고른 수정안.
 *
 * **`patchId` 는 finding 안에서만 유일하다** — 두 finding 이 각각 `p-1` 을 가진다.
 * 확정 화면은 여러 finding 의 수정안을 한꺼번에 다루므로 `findingId` 가 있어야 서로를
 * 구분할 수 있다. 이걸 빼면 다른 finding 의 `p-1` 끼리 같은 것으로 취급된다.
 */
export interface SelectedPatch extends Patch {
  readonly findingId: number;
}

/** 선택 하나를 가리키는 키 */
export function selectionKey(s: { findingId: number; patchId: string }): string {
  return `${s.findingId}:${s.patchId}`;
}
