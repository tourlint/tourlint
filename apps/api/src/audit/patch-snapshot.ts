import { createHash } from 'node:crypto';
import type { EndTimeSource, ItemType, MatchStatus } from '@tourlint/shared';
import type { ItineraryItemRow } from './audit-runner';

/**
 * 일정 스냅샷 (DB 명세서 4-4 · FR-PA-021 · 028).
 *
 * 확정 직전과 직후의 일정을 통째로 담는다. 되돌리기는 `before_snapshot` 을 **그대로
 * 재적용**하는 것이라(FR-PA-026), 스냅샷이 담지 않은 값은 되돌아오지 않는다.
 *
 * ## 항목 `id` 를 담는 이유
 *
 * DB 명세서 4-4 의 예시에는 `id` 가 없다. 그대로 만들면 되돌리기가 항목을 **새 id 로**
 * 되살리고, 그 순간 `finding.target_item_id` 와 `notification.affectedItemIds` 가 전부
 * 없는 항목을 가리킨다. 되돌리면 돌아가야 할 곳이 `before_audit_run_id` 의 검수 결과인데
 * 그 결과가 지목하는 대상이 사라지는 것이다. `id` 를 담아 같은 자리로 되살린다.
 *
 * 지웠던 id 를 다시 넣어도 안전하다 — `bigserial` 은 값을 재사용하지 않으므로 그 사이
 * 다른 행이 그 번호를 가져갔을 수 없다.
 *
 * 공사 원문은 담지 않는다. `placeLabel` 은 사용자가 입력한 장소명이고(DR-PR-001),
 * 대체 관광지는 명칭 대신 `ktoContentId` 만 남는다.
 */

export const SNAPSHOT_VERSION = '1.0';

/**
 * 스냅샷 항목. 키 이름은 DB 명세서 4-4 의 저장 형태를 따른다 —
 * 좌표는 `mapx` · `mapy` 로, 코드 안의 `mapX` · `mapY` 와 철자가 다르다.
 */
export interface SnapshotItem {
  readonly id: number;
  readonly dayNo: number;
  readonly seq: number;
  readonly startTime: string;
  readonly endTime: string | null;
  readonly endTimeSource: EndTimeSource;
  readonly placeLabel: string;
  readonly itemType: ItemType;
  readonly ktoContentId: string | null;
  readonly contentTypeId: number | null;
  readonly lclsSystm1: string | null;
  readonly lclsSystm2: string | null;
  readonly lclsSystm3: string | null;
  readonly mapx: number | null;
  readonly mapy: number | null;
  readonly matchStatus: MatchStatus;
}

export interface ItinerarySnapshot {
  readonly snapshotVersion: string;
  readonly snapshotAt: string;
  readonly productId: number;
  readonly items: readonly SnapshotItem[];
}

export function toSnapshot(
  productId: number,
  items: readonly ItineraryItemRow[],
  snapshotAt: Date,
): ItinerarySnapshot {
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    snapshotAt: snapshotAt.toISOString(),
    productId,
    items: items.map((i) => ({
      id: i.id,
      dayNo: i.dayNo,
      seq: i.seq,
      startTime: i.startTime,
      endTime: i.endTime,
      endTimeSource: i.endTimeSource,
      placeLabel: i.placeLabel,
      itemType: i.itemType,
      ktoContentId: i.ktoContentId,
      contentTypeId: i.contentTypeId,
      lclsSystm1: i.lclsSystm1,
      lclsSystm2: i.lclsSystm2,
      lclsSystm3: i.lclsSystm3,
      mapx: i.mapX,
      mapy: i.mapY,
      matchStatus: i.matchStatus,
    })),
  };
}

/** 스냅샷을 일정표로 되돌린다. 되돌리기가 DB 에 쓸 목록이 된다 */
export function fromSnapshot(snapshot: ItinerarySnapshot): readonly ItineraryItemRow[] {
  return snapshot.items.map((i) => ({
    id: i.id,
    dayNo: i.dayNo,
    seq: i.seq,
    startTime: i.startTime,
    endTime: i.endTime,
    endTimeSource: i.endTimeSource,
    placeLabel: i.placeLabel,
    itemType: i.itemType,
    ktoContentId: i.ktoContentId,
    contentTypeId: i.contentTypeId,
    lclsSystm1: i.lclsSystm1,
    lclsSystm2: i.lclsSystm2,
    lclsSystm3: i.lclsSystm3,
    mapX: i.mapx,
    mapY: i.mapy,
    matchStatus: i.matchStatus,
  }));
}

/**
 * 미리보기 토큰 (API 설계 5-8 · EX-PA-002).
 *
 * **저장하지 않는다.** 일정 상태를 그대로 해싱한 값이라 확정 시점에 다시 계산해 맞춰
 * 보면 된다 — 미리보기가 아무것도 쓰지 않는다는 F08 의 전제를 지키면서 "그 사이 일정이
 * 바뀌었는가" 를 답할 수 있다. 서버에 토큰 표를 두면 만료 청소라는 일이 하나 더 붙는데,
 * 정작 알고 싶은 것은 만료가 아니라 **일정이 그대로인가** 다.
 *
 * 시각은 넣지 않는다. 넣으면 매번 달라져 토큰이 항상 어긋난다.
 *
 * 필드는 U+001F 로 잇는다. 그냥 이어 붙이면 `("AB","C")` 와 `("A","BC")` 가 같은 문자열이
 * 되어 서로 다른 일정이 같은 토큰을 갖는다 — 지문 해시가 같은 구분자를 쓰는 이유와
 * 같다 (DR-FP-004).
 */
const UNIT_SEPARATOR = '\u001F';

export function snapshotToken(items: readonly ItineraryItemRow[]): string {
  const canonical = [...items]
    .sort((a, b) => a.id - b.id)
    .map((i) =>
      [
        i.id, i.dayNo, i.seq, i.startTime, i.endTime ?? '', i.endTimeSource,
        i.placeLabel, i.itemType, i.ktoContentId ?? '', i.contentTypeId ?? '',
        i.lclsSystm1 ?? '', i.lclsSystm2 ?? '', i.lclsSystm3 ?? '',
        i.mapX ?? '', i.mapY ?? '', i.matchStatus,
      ].join(UNIT_SEPARATOR),
    )
    .join(UNIT_SEPARATOR);
  return `pv_${createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12)}`;
}
