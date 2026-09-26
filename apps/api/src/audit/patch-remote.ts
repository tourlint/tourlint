import { LCLS_SYSTM2, LOCATION_RADIUS_MAX_METERS, type ContentTypeId } from '@tourlint/shared';
import { isSupportedContentTypeId } from '../engine/fingerprint';
import { addMinutes } from '../engine/itinerary/dwell';
import { toMinutes } from '../engine/normalize/primitives';
import { pointOf, straightMeters } from '../engine/geo';
import type { AuditItem } from '../engine/rules/types';
import { isKtoError, type KtoClient } from '../external/kto';
import { patchId, type Patch, type ReplaceContentPayload } from './patch-types';

/**
 * 대체 관광지 수정안 (`REPLACE_CONTENT`).
 *
 * 유일하게 외부 호출이 필요한 수정안이라 따로 뒀다. 판정이 끝난 **뒤** 별도 단계에서
 * 돌린다 — 규칙 평가는 메모리 전용이어야 하기 때문이다 (NF-PF-014 · API 설계 6-1 8단계).
 *
 * 정렬은 **① 동일 `contentTypeId` 우선 ①-2 같은 중분류 우선 ② 거리 오름차순 ③ 해석 신뢰도
 * 확정 우선** (FR-PA-003). 공사 데이터에 평점이 없으므로 평점 정렬은 쓰지 않는다.
 *
 * ①-2 가 없으면 음식점(39) 안에서 한식과 카페를 가리지 않는다 — 휴무인 점심 식당의 대체로
 * 과자점 · 카페가 나왔다 (#728).
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
  /**
   * `center` 가 어느 항목의 자리인지. 주면 payload 에 실어 화면이 「앞 일정 ○○에서 약 0.4km」 로
   * 적는다. 안 주면 거리는 바꿀 장소에서 잰 것이다 (#728).
   */
  readonly centerItemId?: number;
  /**
   * R04 가 지목한 반복 묶음. 이 키와 같은 후보는 반영해도 지적이 그대로라 뺀다 (FR-RU-043).
   *
   * 축이 `contentTypeId` 면 같은 유형으로 조회해서는 고칠 후보가 안 나온다 — 유형 제한 없이
   * 받아 다른 관광 유형만 남긴다.
   */
  readonly avoid?: { readonly axis: 'contentTypeId' | 'lclsSystm3'; readonly key: string };
  /**
   * 실내 중분류만 받는다 — R09 ③ 우천 대체 (FR-RU-094 · #880). 실내 관광지는 문화시설(14)이 많아
   * 유형을 대상과 맞추지 않고 관광 유형(12 · 14 · 28) 안에서 고른다.
   */
  readonly indoorLcls2?: ReadonlySet<string>;
  /** 제시할 후보 수. 기본 `MAX_CANDIDATES` */
  readonly limit?: number;
}

/**
 * R04 유형 축에서 대신 넣을 수 있는 관광 유형 — 관광지 · 문화시설 · 레포츠.
 *
 * 음식점 · 숙박 · 행사 · 코스는 방문지 대체가 아니다. **쇼핑(38)도 뺀다** — 전통시장도 있지만
 * 마트 · 회센터가 같은 유형이라, 가까운 순으로 고르면 등대 자리에 마트가 왔다 (#748).
 */
const SIGHT_TYPES: ReadonlySet<number> = new Set([12, 14, 28]);

/** 식사 자리에 권하지 않는 중분류 — 주점 · 카페/찻집. 원래 그 분류였으면 그대로 둔다 */
const NOT_A_MEAL: ReadonlySet<string> = new Set(['FD04', 'FD05']);

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
  const avoid = options.avoid;
  const indoor = options.indoorLcls2;
  const anyType = avoid?.axis === 'contentTypeId' || indoor !== undefined;
  let items: readonly Record<string, unknown>[];
  try {
    const page = await options.kto.locationBasedList({
      mapX: center.x, mapY: center.y, radius,
      ...(anyType ? {} : { contentTypeId: target.content.contentTypeId }),
      // 유형 제한이 없으면 가까운 식당 · 숙박이 앞을 채운다. 넉넉히 받아 거른다
      numOfRows: anyType ? 40 : 20,
    });
    items = page.items;
  } catch (e) {
    // 수정안을 못 만드는 것은 판정 실패가 아니다. 조용히 비우고 검수는 그대로 둔다
    if (isKtoError(e)) return [];
    throw e;
  }

  const usable = items
    .filter((raw) => !isConvenienceFacility(raw))
    .filter((raw) => fitsMeal(raw, target))
    .filter((raw) => avoid === undefined || breaksRepeat(raw, avoid))
    .filter((raw) => indoor === undefined || isIndoorSight(raw, indoor));

  return rankCandidates(usable, target, options.knownConfidence ?? new Map())
    .slice(0, options.limit ?? MAX_CANDIDATES)
    .map((c, i) => ({
      patchId: patchId(startIndex + i),
      type: 'REPLACE_CONTENT' as const,
      targetItemId: target.id,
      payload: options.centerItemId === undefined ? c : { ...c, fromItemId: options.centerItemId },
    }));
}

/** 실내로 분류된 관광 유형(12 · 14 · 28)인가. 중분류를 모르면 실내라고 말할 수 없다 */
function isIndoorSight(raw: Record<string, unknown>, indoor: ReadonlySet<string>): boolean {
  const code = typeof raw.lclsSystm2 === 'string' ? raw.lclsSystm2 : '';
  return SIGHT_TYPES.has(Number(raw.contenttypeid)) && indoor.has(code);
}

/**
 * R02 — 여행일에 열리는 **같은 지역 행사**로 교체 (FR-RU-022 ① · #880).
 *
 * 상품 지역의 행사를 여행일 기준으로 한 번 조회해(`searchFestival2` — 그날 아직 끝나지 않은 행사가
 * 온다) 여행일이 기간 안에 드는 것만 남긴다. 가까운 순으로 두 곳. 좌표가 없는 행사는 거리를 말할 수
 * 없어 뺀다 — 대상의 좌표가 없으면 부르지 않는다(대체 관광지와 같다).
 * 명칭은 담지 않는다(DR-PR-001). 표시할 때 조회한다.
 */
export async function proposeEventReplacements(
  target: AuditItem,
  options: {
    readonly kto: KtoClient;
    readonly region: { readonly regnCd: string | null; readonly signguCd: string | null };
    readonly exclude: ReadonlySet<string>;
    readonly limit?: number;
  },
  startIndex = 0,
): Promise<{ readonly patches: readonly Patch[]; readonly called: boolean }> {
  const from = pointOf(target);
  const regnCd = options.region.regnCd;
  if (from === null || regnCd === null || regnCd === '') return { patches: [], called: false };
  const visit = target.date.replace(/-/g, '');

  let items: readonly Record<string, unknown>[];
  try {
    const page = await options.kto.searchFestival({
      eventStartDate: visit,
      lDongRegnCd: regnCd,
      ...(options.region.signguCd === null || options.region.signguCd === '' ? {} : { lDongSignguCd: options.region.signguCd }),
      numOfRows: 50,
    });
    items = page.items;
  } catch (e) {
    if (isKtoError(e)) return { patches: [], called: true };
    throw e;
  }

  const rows: ReplaceContentPayload[] = [];
  for (const raw of items) {
    const id = String(raw.contentid ?? '');
    const start = String(raw.eventstartdate ?? '');
    const end = String(raw.eventenddate ?? '');
    if (id === '' || options.exclude.has(id) || id === target.content?.ktoContentId) continue;
    if (!/^\d{8}$/.test(start) || !/^\d{8}$/.test(end) || start > visit || visit > end) continue;
    const x = toNumber(raw.mapx);
    const y = toNumber(raw.mapy);
    if (x === null || y === null) continue;
    rows.push({
      ktoContentId: id,
      contentTypeId: 15,
      lclsSystm2: typeof raw.lclsSystm2 === 'string' && raw.lclsSystm2 !== '' ? raw.lclsSystm2 : null,
      mapx: x,
      mapy: y,
      distanceMeters: Math.round(straightMeters(from, { x, y })),
      parseConfidence: null,
    });
  }

  const patches = rows
    .sort((a, b) => a.distanceMeters - b.distanceMeters || a.ktoContentId.localeCompare(b.ktoContentId))
    .slice(0, options.limit ?? MAX_CANDIDATES)
    .map((payload, i): Patch => ({
      patchId: patchId(startIndex + i), type: 'REPLACE_CONTENT', targetItemId: target.id, payload,
    }));
  return { patches, called: true };
}

/** 식사 항목의 대체는 식사가 되는 곳이어야 한다. 중분류를 모르는 후보는 막지 않는다 */
function fitsMeal(raw: Record<string, unknown>, target: AuditItem): boolean {
  if (target.itemType !== 'MEAL') return true;
  const code = typeof raw.lclsSystm2 === 'string' ? raw.lclsSystm2 : '';
  if (!NOT_A_MEAL.has(code)) return true;
  return target.lclsSystm2 === code;
}

/**
 * 반영하면 R04 의 반복이 줄어드는 후보인가.
 *
 * 분류를 모르는 후보는 넣지 않는다 — R04 가 세지는 않지만 「다른 종류」 라고 말할 수 없다.
 */
function breaksRepeat(
  raw: Record<string, unknown>,
  avoid: NonNullable<ReplacementOptions['avoid']>,
): boolean {
  if (avoid.axis === 'contentTypeId') {
    const typeId = Number(raw.contenttypeid);
    return String(typeId) !== avoid.key && SIGHT_TYPES.has(typeId);
  }
  const code = typeof raw.lclsSystm3 === 'string' ? raw.lclsSystm3 : '';
  return code !== '' && code !== avoid.key;
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

  const wantedLcls2 = target.lclsSystm2;
  return rows.sort((a, b) =>
    // ① 같은 유형 먼저
    sameType(b, wanted) - sameType(a, wanted) ||
    // ①-2 같은 중분류 먼저. 대상의 중분류를 모르면 가리지 않는다
    sameLcls2(b, wantedLcls2) - sameLcls2(a, wantedLcls2) ||
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

function sameLcls2(c: ReplaceContentPayload, wanted: string | null): number {
  return wanted !== null && c.lclsSystm2 === wanted ? 1 : 0;
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
    const ranked = rankCandidates(items.filter((raw) => !isConvenienceFacility(raw)), anchor, options.knownConfidence ?? new Map())
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

/**
 * 방문 일정이 될 수 없는 편의시설.
 *
 * 공사가 `강문해변화장실` 을 랜드마크관광(`VE010100`)으로 분류해 두었다. 분류로는 못 거르고,
 * 상시 개방이라 운영시간 확인도 통과한다 — 그대로 두면 숙소 옆 화장실이 밤 일정으로 나온다
 * (#584). 이름은 거르는 데만 쓰고 수정안에 담지 않는다 (DR-PR-001).
 */
function isConvenienceFacility(raw: Record<string, unknown>): boolean {
  return typeof raw.title === 'string' && raw.title.includes('화장실');
}
