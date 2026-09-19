import { LCLS_SYSTM2, LOCATION_RADIUS_MAX_METERS, type ContentTypeId } from '@tourlint/shared';
import { isSupportedContentTypeId } from '../engine/fingerprint';
import { addMinutes } from '../engine/itinerary/dwell';
import { toMinutes } from '../engine/normalize/primitives';
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
  /** 이 중분류 중 하나여야 한다. 비면 중분류를 따지지 않는다. 앞에 적힌 것부터 찾는다 */
  readonly wantLcls2?: readonly string[];
  /** 이미 일정에 있는 콘텐츠. 같은 것을 또 넣지 않는다 */
  readonly exclude?: ReadonlySet<string>;
  /** 제시할 후보 수. 기본 `MAX_CANDIDATES` */
  readonly limit?: number;
  /** 위치기반 목록을 부를 수 있는 횟수. 기본 1 */
  readonly maxListCalls?: number;
  /**
   * 후보를 받아들일지 묻는다 (야간 자리의 운영시간 확인).
   *
   * 거리순으로 앞에서부터 묻고 `maxVerifications` 번까지만 묻는다 — 물을 때마다 소개정보를
   * 한 번 부르기 때문이다.
   */
  readonly verify?: (candidate: ReplaceContentPayload, slot: InsertionSlot) => Promise<boolean>;
  readonly maxVerifications?: number;
  /**
   * 중분류별 기본 체류시간(분). 주면 후보의 중분류에 맞춰 종료시각을 당긴다 (FR-IN-011).
   *
   * 자리는 기본 90분으로 잡지만 카페는 60분이다. 사용자가 직접 담을 때와 같은 길이로 넣어야
   * 하고, 야간 자리는 이 차이로 운영시간 안에 드느냐가 갈린다 — 20:00 에 닫는 곳이 많다.
   * **늘리지는 않는다.** 자리는 그 길이가 들어가는지만 확인한 것이다.
   */
  readonly dwellOf?: (lclsSystm2: string | null) => number;
}

/**
 * 분류로 좁혀 부를 수 있는 중분류 수의 상한.
 *
 * R10 의 기대 중분류는 많아야 셋이라 하나씩 좁혀 부른다. R09 의 실내 중분류는 열 개가
 * 넘어 하나씩 부를 수 없다 — 그쪽은 종전대로 분류 없이 한 번 받아 거른다.
 */
const MAX_FILTERED_CODES = 3;

export async function proposeInsertions(
  anchor: AuditItem,
  slot: InsertionSlot,
  options: InsertionOptions,
  startIndex = 0,
): Promise<{ readonly patches: readonly Patch[]; readonly listCalls: number; readonly verifications: number }> {
  const center = options.center ?? (anchor.mapX === null || anchor.mapY === null
    ? null
    : { x: anchor.mapX, y: anchor.mapY });
  if (center === null) return { patches: [], listCalls: 0, verifications: 0 };

  const radius = Math.min(options.radiusMeters ?? LOCATION_RADIUS_MAX_METERS, LOCATION_RADIUS_MAX_METERS);
  const want = options.wantLcls2 ?? [];
  const limit = options.limit ?? MAX_CANDIDATES;
  const maxListCalls = options.maxListCalls ?? 1;
  const maxVerifications = options.maxVerifications ?? 0;
  const exclude = options.exclude ?? new Set<string>();

  /*
   * **결손 중분류로 좁혀 부른다.** 분류 없이 받은 30건은 가까운 식당 · 숙박으로 찬다 —
   * 주문진 기준 실호출에서 `FD01` 21 · `AC03` 4 · `AC04` 2 였고 찾던 `EX02` 는 0건이었다.
   * 좁히면 반경 20km 에서 1건이 나온다 (#579). 거르는 것만으로는 없는 것을 못 찾는다.
   */
  const queries: readonly (string | null)[] =
    want.length > 0 && want.length <= MAX_FILTERED_CODES ? want : [null];

  const picked: ReplaceContentPayload[] = [];
  let listCalls = 0;
  let verifications = 0;

  for (const code of queries) {
    if (picked.length >= limit || listCalls >= maxListCalls) break;
    // 더 물어볼 수 없으면 목록을 받아 봐야 쓸 데가 없다
    if (options.verify !== undefined && verifications >= maxVerifications) break;
    const parent = code === null ? undefined : LCLS_SYSTM2[code]?.parent;
    // 기준표에 없는 코드로는 부르지 않는다. 대분류 없이 중분류만 보내면 공사가 거절한다
    if (code !== null && parent === undefined) continue;

    let items: readonly Record<string, unknown>[];
    try {
      listCalls += 1;
      const page = await options.kto.locationBasedList({
        mapX: center.x, mapY: center.y, radius, numOfRows: 30,
        ...(code === null ? {} : { lclsSystm1: parent, lclsSystm2: code }),
      });
      items = page.items;
    } catch (e) {
      if (isKtoError(e)) continue;
      throw e;
    }

    const wanted = new Set(code === null ? want : [code]);
    const ranked = rankCandidates(items, anchor, options.knownConfidence ?? new Map())
      .filter((c) => !exclude.has(c.ktoContentId) && !picked.some((p) => p.ktoContentId === c.ktoContentId))
      // 중분류를 지정했으면 그 중 하나여야 한다. 모르는 것(null)은 넣지 않는다 — 결손을 채운다고 말할 수 없다
      .filter((c) => wanted.size === 0 || (c.lclsSystm2 !== null && wanted.has(c.lclsSystm2)));

    for (const candidate of ranked) {
      if (picked.length >= limit) break;
      if (options.verify !== undefined) {
        if (verifications >= maxVerifications) break;
        verifications += 1;
        if (!(await options.verify(candidate, fitSlot(slot, candidate, options.dwellOf)))) continue;
      }
      picked.push(candidate);
    }
  }

  const patches = picked.map((c, i) => {
    const fitted = fitSlot(slot, c, options.dwellOf);
    return {
      patchId: patchId(startIndex + i),
      type: 'INSERT_ITEM' as const,
      // 자리를 가리키는 항목. 하루의 맨 앞이면 기준 항목을 쓴다 (Patch.targetItemId 는 필수다)
      targetItemId: slot.afterItemId ?? anchor.id,
      payload: {
        dayNo: slot.dayNo,
        afterItemId: slot.afterItemId,
        startTime: fitted.startTime,
        endTime: fitted.endTime,
        itemType: 'SIGHT' as const,
        content: {
          ktoContentId: c.ktoContentId,
          contentTypeId: c.contentTypeId,
          lclsSystm2: c.lclsSystm2,
          mapx: c.mapx,
          mapy: c.mapy,
        },
      },
    };
  });
  return { patches, listCalls, verifications };
}

/** 후보의 중분류 체류시간이 잡아 둔 자리보다 짧으면 종료시각을 당긴다 */
function fitSlot(
  slot: InsertionSlot,
  candidate: ReplaceContentPayload,
  dwellOf: InsertionOptions['dwellOf'],
): InsertionSlot {
  if (dwellOf === undefined) return slot;
  const planned = toMinutes(slot.endTime) - toMinutes(slot.startTime);
  const minutes = Math.min(planned, dwellOf(candidate.lclsSystm2));
  return minutes <= 0 || minutes === planned ? slot : { ...slot, endTime: addMinutes(slot.startTime, minutes) };
}
