import { LOCATION_RADIUS_MAX_METERS, type ContentTypeId } from '@tourlint/shared';
import { isSupportedContentTypeId } from '../engine/fingerprint';
import type { AuditItem } from '../engine/rules/types';
import { isKtoError, type KtoClient } from '../external/kto';
import { patchId, type Patch, type ReplaceContentPayload } from './patch-types';

/**
 * 대체 관광지 수정안 (`REPLACE_CONTENT`).
 *
 * 유일하게 외부 호출이 필요한 수정안이라 따로 뒀다. 판정이 끝난 **뒤** 별도 단계에서
 * 돌린다 — 규칙 평가는 메모리 전용이어야 하기 때문이다 (NF-PF-014 · API 설계 6-1 8단계).
 *
 * 정렬은 **① 동일 `contentTypeId` 우선 ② 거리 오름차순 ③ 해석 신뢰도 확정 우선** (FR-PA-003).
 * 공사 데이터에 평점이 없으므로 평점 정렬은 쓰지 않는다.
 *
 * ⚠️ 후보의 **명칭을 담지 않는다.** 명칭은 공사 원문이라 저장하면 DR-PR-001 위반이다.
 *    `ktoContentId` 만 담고 화면이 표시 시점에 조회한다.
 */

/** 한 finding 에 제시할 대체 후보 수. 최대 3개 중 다른 수정안 자리를 남긴다 */
const MAX_CANDIDATES = 2;

export interface ReplacementOptions {
  readonly kto: KtoClient;
  /** 반경(m). 상한 20km (SC-DT-013 · EI-KT-008) */
  readonly radiusMeters?: number;
  /** 이번 실행에서 이미 알고 있는 해석 신뢰도. `ktoContentId` → 신뢰도 */
  readonly knownConfidence?: ReadonlyMap<string, 'CONFIRMED' | 'ESTIMATED' | 'UNPARSED'>;
  /**
   * 검색 중심. 안 주면 대체 대상 자리에서 찾는다.
   *
   * R08 은 **앞 항목** 을 중심으로 찾아야 한다 (FR-RU-083 ③). 너무 먼 곳이 문제인데 그
   * 자리에서 찾으면 여전히 먼 것들만 나온다.
   */
  readonly center?: { readonly x: number; readonly y: number };
}

/**
 * 반경 안 같은 유형 관광지를 찾아 대체 수정안으로 만든다.
 *
 * 좌표가 없으면 찾을 수 없다 — 그때는 빈 배열을 준다. 억지로 지역 검색으로 넘어가지 않는다.
 * 엉뚱한 지역의 관광지를 제안하면 없느니만 못하다.
 */
export async function proposeReplacements(
  target: AuditItem,
  options: ReplacementOptions,
  startIndex = 0,
): Promise<readonly Patch[]> {
  if (target.content === null) return [];
  const center = options.center ?? (target.mapX === null || target.mapY === null
    ? null
    : { x: target.mapX, y: target.mapY });
  if (center === null) return [];

  const radius = Math.min(options.radiusMeters ?? LOCATION_RADIUS_MAX_METERS, LOCATION_RADIUS_MAX_METERS);
  let items: readonly Record<string, unknown>[];
  try {
    const page = await options.kto.locationBasedList({
      mapX: center.x, mapY: center.y, radius,
      contentTypeId: target.content.contentTypeId,
      numOfRows: 20,
    });
    items = page.items;
  } catch (e) {
    // 수정안을 못 만드는 것은 판정 실패가 아니다. 조용히 비우고 검수는 그대로 둔다
    if (isKtoError(e)) return [];
    throw e;
  }

  return rankCandidates(items, target, options.knownConfidence ?? new Map())
    .slice(0, MAX_CANDIDATES)
    .map((c, i) => ({
      patchId: patchId(startIndex + i),
      type: 'REPLACE_CONTENT' as const,
      targetItemId: target.id,
      payload: c,
    }));
}

/** FR-PA-003 정렬. 순위가 흔들리면 같은 검수가 실행마다 다른 수정안을 낸다 (NF-MT-001) */
export function rankCandidates(
  items: readonly Record<string, unknown>[],
  target: AuditItem,
  knownConfidence: ReadonlyMap<string, 'CONFIRMED' | 'ESTIMATED' | 'UNPARSED'>,
): readonly ReplaceContentPayload[] {
  const wanted = target.content?.contentTypeId;
  const excluded = new Set([target.content?.ktoContentId ?? '']);

  const rows: ReplaceContentPayload[] = [];
  for (const raw of items) {
    const id = String(raw.contentid ?? '');
    const typeId = Number(raw.contenttypeid);
    if (id === '' || excluded.has(id) || !isSupportedContentTypeId(typeId)) continue;
    excluded.add(id);

    rows.push({
      ktoContentId: id,
      contentTypeId: typeId as ContentTypeId,
      lclsSystm2: typeof raw.lclsSystm2 === 'string' && raw.lclsSystm2 !== '' ? raw.lclsSystm2 : null,
      mapx: toNumber(raw.mapx),
      mapy: toNumber(raw.mapy),
      distanceMeters: Math.round(toNumber(raw.dist) ?? 0),
      parseConfidence: knownConfidence.get(id) ?? null,
    });
  }

  return rows.sort((a, b) =>
    // ① 같은 유형 먼저
    sameType(b, wanted) - sameType(a, wanted) ||
    // ② 가까운 순
    a.distanceMeters - b.distanceMeters ||
    // ③ 해석이 확정된 것 먼저
    confidenceRank(b.parseConfidence) - confidenceRank(a.parseConfidence) ||
    // 마지막은 id 로 고정한다 — 동률에서 순서가 흔들리면 안 된다
    a.ktoContentId.localeCompare(b.ktoContentId),
  );
}

function sameType(c: ReplaceContentPayload, wanted: ContentTypeId | undefined): number {
  return wanted !== undefined && c.contentTypeId === wanted ? 1 : 0;
}

/** 신뢰도를 모르는 후보(null)는 중립으로 둔다. 대부분의 후보가 여기 해당한다 */
function confidenceRank(c: ReplaceContentPayload['parseConfidence']): number {
  return c === 'CONFIRMED' ? 2 : c === 'ESTIMATED' ? 1 : 0;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 조건에 맞는 관광지를 **일정에 넣는** 수정안 (`INSERT_ITEM`).
 *
 * R10 은 결손 유형을, R09 는 실내 유형을 채운다 (FR-RU-103 · 093 ①). 대체가 아니라 추가라
 * 자리(빈 시간대)를 호출자가 정해 넘긴다 — 자리 계산은 0콜이고 여기는 콘텐츠만 찾는다.
 *
 * ⚠️ 후보의 **명칭을 담지 않는다.** 대체 관광지와 같은 이유다 (DR-PR-001).
 */
export interface InsertionSlot {
  readonly dayNo: number;
  readonly afterItemId: number | null;
  readonly startTime: string;
  readonly endTime: string;
}

export interface InsertionOptions extends ReplacementOptions {
  /** 이 중분류 중 하나여야 한다. 비면 중분류를 따지지 않는다 */
  readonly wantLcls2?: readonly string[];
  /** 이미 일정에 있는 콘텐츠. 같은 것을 또 넣지 않는다 */
  readonly exclude?: ReadonlySet<string>;
}

export async function proposeInsertions(
  anchor: AuditItem,
  slot: InsertionSlot,
  options: InsertionOptions,
  startIndex = 0,
): Promise<readonly Patch[]> {
  const center = options.center ?? (anchor.mapX === null || anchor.mapY === null
    ? null
    : { x: anchor.mapX, y: anchor.mapY });
  if (center === null) return [];

  const radius = Math.min(options.radiusMeters ?? LOCATION_RADIUS_MAX_METERS, LOCATION_RADIUS_MAX_METERS);
  let items: readonly Record<string, unknown>[];
  try {
    // 유형을 좁히지 않는다 — 원하는 중분류가 어느 유형에 들어 있을지 여기서 단정할 수 없다
    const page = await options.kto.locationBasedList({ mapX: center.x, mapY: center.y, radius, numOfRows: 30 });
    items = page.items;
  } catch (e) {
    if (isKtoError(e)) return [];
    throw e;
  }

  const wanted = new Set(options.wantLcls2 ?? []);
  const exclude = options.exclude ?? new Set<string>();
  const picked = rankCandidates(items, anchor, options.knownConfidence ?? new Map())
    .filter((c) => !exclude.has(c.ktoContentId))
    // 중분류를 지정했으면 그 중 하나여야 한다. 모르는 것(null)은 넣지 않는다 — 결손을 채운다고 말할 수 없다
    .filter((c) => wanted.size === 0 || (c.lclsSystm2 !== null && wanted.has(c.lclsSystm2)))
    .slice(0, MAX_CANDIDATES);

  return picked.map((c, i) => ({
    patchId: patchId(startIndex + i),
    type: 'INSERT_ITEM' as const,
    // 자리를 가리키는 항목. 하루의 맨 앞이면 기준 항목을 쓴다 (Patch.targetItemId 는 필수다)
    targetItemId: slot.afterItemId ?? anchor.id,
    payload: {
      dayNo: slot.dayNo,
      afterItemId: slot.afterItemId,
      startTime: slot.startTime,
      endTime: slot.endTime,
      itemType: 'SIGHT' as const,
      content: {
        ktoContentId: c.ktoContentId,
        contentTypeId: c.contentTypeId,
        lclsSystm2: c.lclsSystm2,
        mapx: c.mapx,
        mapy: c.mapy,
      },
    },
  }));
}
