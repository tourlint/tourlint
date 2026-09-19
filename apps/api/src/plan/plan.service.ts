import { HttpStatus, Logger } from '@nestjs/common';
import {
  INDOOR_OUTDOOR_SEED,
  LCLS_SYSTM2,
  PLAN_BASE_LCLS2,
  PLAN_EXCLUDED_LCLS1,
  PLAN_NEAR_KIND,
  PLAN_NEAR_RADIUS_M,
  matchesNearKind,
  type ContentTypeId,
  type KtoService,
  type PlanBriefing,
  type PlanEvent,
  type PlanNearKind,
  type PlanPlace,
  type PlanTypeChip,
  type PlanWalk,
} from '@tourlint/shared';
import { DomainException } from '../common/domain.exception';
import { addDays, formatIsoDate, parseIsoDate } from '../engine/calendar/dates';
import type { BudgetDecision } from '../external/budget-guard';
import { isKtoError, KtoFetchError, type KtoClient, type KtoListPage } from '../external/kto';
import { PlanCache } from './plan-cache';
import { factFields } from './place-facts.service';
import { isCourseInRegion, toWalk } from './plan-region';

/**
 * 상품 기획 조회 (F17 · FR-PL-004 · 010 ~ 012 · 018 · API 4-10).
 *
 * **판정하지 않는다.** 규칙 함수를 부르지 않고 `audit_run` · `finding` 을 만들지 않으며, 등급 ·
 * 규칙 번호 · 통과 여부를 응답에 두지 않는다 — 기획 화면은 관광정보 사실만 보인다 (FR-PL-021).
 *
 * **저장하지 않는다.** 제목 · 주소 · 사진 URL 은 응답으로만 흐르고 DB · 로그에 남지 않는다
 * (DB 명세서 6-4 · DR-PR-009). 같은 조회를 반복하지 않도록 10분 메모리 캐시만 둔다.
 *
 * **예산은 검수와 같은 문이다** (D2 · EI-CM-012). 국문 관광정보가 100% 면 429 로 막고, 새 서비스
 * 하나가 막히거나 실패하면 그 필드만 `null` 로 둔다 — 화면의 일정 입력 · 저장은 계속된다.
 */

/** 그 서비스를 지금 부를 수 있는가. 부르기 전에 본다 (`PLAN` 의도 · 경계 100%) */
export type PlanBudget = (service: KtoService) => Promise<BudgetDecision>;

export interface PlanServiceOptions {
  readonly kto: () => KtoClient;
  readonly budget: PlanBudget;
  readonly cache?: PlanCache;
}

export interface PlanRegion {
  readonly regnCd: string;
  readonly signguCd: string | null;
}

export interface BriefingQuery extends PlanRegion {
  readonly startDate: string;
  readonly nights: number;
  /** "자주 넣는 곳"에서 연 중분류. 음식 · 숙박 · 추천코스는 첫째 줄에 두지 않는다 */
  readonly extraLcls2: readonly string[];
}

export interface PlacesQuery extends PlanRegion {
  readonly scope: 'SIGNGU' | 'NEAR3KM';
  readonly lcls2: string | null;
  readonly nearKind: PlanNearKind | null;
  readonly sort: 'near' | 'together' | null;
  readonly anchor: { readonly mapx: number; readonly mapy: number } | null;
  readonly anchorContentId: string | null;
  readonly wheelchair: boolean;
  readonly pet: boolean;
  readonly indoor: boolean;
  readonly page: number;
}

export interface PlacesResult {
  readonly scope: { readonly kind: 'SIGNGU' | 'NEAR' | 'NEAR3KM'; readonly label: string };
  readonly totalCount: number;
  readonly items: readonly PlanPlace[];
  readonly disabled: 'ANCHOR_REQUIRED' | null;
  readonly notice: string | null;
}

export interface PlaceDetailQuery {
  readonly contentId: string;
  readonly contentTypeId: number;
}

/** 카드 「자세히」 값 — 공사 원문 표시값이라 응답으로만 흐른다 (DB 명세서 6-4) */
export interface PlaceDetailResult {
  readonly contentId: string;
  readonly hours: string | null;
  readonly restDays: string | null;
  readonly fee: string | null;
  readonly parking: string | null;
  readonly eventPeriod: string | null;
}

/** 시군구 목록 한 번에 받는 행 수. 칩의 `totalCount` 와 같은 조회다 */
export const PLAN_LIST_ROWS = 100;
/** 근처 3km 원본의 페이지 크기 — 강릉 3km 음식점이 185건이었다 (2026.09.15 실호출) */
export const PLAN_NEAR_ROWS = 1000;
/** 가까운 순 정렬용 반경 (API 4-10) */
export const PLAN_SORT_NEAR_RADIUS_M = 20_000;
/** 한 쪽에 보이는 장소 수 */
export const PLAN_PAGE_SIZE = 20;

const BUDGET_MESSAGE =
  '오늘 쓸 수 있는 관광정보 조회를 모두 썼습니다. 내일 0시부터 다시 볼 수 있고, 일정 입력과 저장은 지금도 할 수 있습니다.';
const PARTIAL_NOTICE = '지금 불러오지 못한 정보가 있어 일부 표시가 비어 있습니다.';

export class PlanService {
  private readonly logger = new Logger(PlanService.name);
  private readonly kto: () => KtoClient;
  private readonly budget: PlanBudget;
  private readonly cache: PlanCache;

  constructor(options: PlanServiceOptions) {
    this.kto = options.kto;
    this.budget = options.budget;
    this.cache = options.cache ?? new PlanCache();
  }

  /**
   * 종류 칩 첫째 줄 (FR-PL-010 · D6).
   *
   * 기본 4 + 축제 · 공연 + 걷기 길 = 6콜이고 지역이 바뀔 때만 다시 센다. 둘째 줄(식당 · 카페 ·
   * 숙소)은 여기서 세지 않는다 — 넣을 위치가 정해져야 반경을 잡을 수 있다.
   */
  async briefing(query: BriefingQuery): Promise<PlanBriefing> {
    await this.assertKorBudget();
    const region = await this.regionOf(query);

    const types: PlanTypeChip[] = [];
    for (const lcls2 of chipCodes(query.extraLcls2)) {
      types.push({
        kind: 'LCLS2',
        lcls2,
        nearKind: null,
        name: LCLS_SYSTM2[lcls2]?.name ?? lcls2,
        count: await this.countOf(query, lcls2),
        disabled: null,
      });
    }

    const window = eventWindow(query.startDate, query.nights);
    const events = window === null ? null : await this.eventCount(query, window);
    types.push({ kind: 'EVENT', lcls2: null, nearKind: null, name: '축제 · 공연', count: events?.count ?? null, disabled: null });

    const walks = await this.walkCount(query, region.signguName);
    types.push({ kind: 'WALK', lcls2: null, nearKind: null, name: '걷기 길', count: walks?.count ?? null, disabled: null });

    const [accessible, pet] = await Promise.all([
      this.contentIdSet(query, 'WITH'),
      this.contentIdSet(query, 'PET'),
    ]);

    return {
      region: { regnCd: query.regnCd, signguCd: query.signguCd, name: region.name },
      types,
      events,
      accessible: accessible === null ? null : { count: accessible.size },
      pet: pet === null ? null : { count: pet.size },
      walks,
      budget: await this.budgetState(),
    };
  }

  /**
   * 장소 목록 (FR-PL-010 · 011).
   *
   * 시군구 전체는 칩과 **같은 조건**의 전체 원본 목록을 페이지 조회한다. 근처 3km 는
   * 앵커 기준 전체 목록을 종류로 거른 것이고, 앵커가 없으면 부르지 않는다.
   */
  async places(query: PlacesQuery): Promise<PlacesResult> {
    if (query.scope === 'NEAR3KM') return this.nearPlaces(query);
    return this.signguPlaces(query);
  }

  /**
   * 축제 · 공연 (FR-PL-014). 여행 기간 앞뒤 3일에 열리는 행사 1콜이다.
   *
   * 기간 관계는 **참고 표시일 뿐** 판정이 아니다 — 겹치는지 아닌지는 검수의 R02 가 본다. 겹치지
   * 않는 행사에는 옮길 출발일을 제안하고, 겹치면 제안하지 않는다.
   */
  async events(query: BriefingQuery): Promise<{ window: { from: string; to: string } | null; items: readonly PlanEvent[] }> {
    await this.assertKorBudget();
    const window = eventWindow(query.startDate, query.nights);
    if (window === null) return { window: null, items: [] };

    const page = await this.cache.getOrLoad(`eventList:${regionKey(query)}:${window.from}:${window.to}`, async () =>
      this.kto().searchFestival({
        eventStartDate: window.from.replace(/-/g, ''),
        ...ldongParams(query),
        numOfRows: PLAN_LIST_ROWS,
      }));

    const items = visibleItems(page)
      .filter((item) => overlapsOrLater(item, window))
      .map((item) => toEvent(item, query))
      .filter((event): event is PlanEvent => event !== null);
    return { window, items };
  }

  /**
   * 걷기 길 (FR-PL-015 · EI-KT-025).
   *
   * 두루누비는 지역 조건이 없어 전국 목록 1콜을 시군구 글자로 거른다. 좌표가 없어 근처 3km 의
   * 기준이 되지 않고, 일정에 넣으면 직접 정한 곳이 된다.
   */
  async walks(query: PlanRegion): Promise<{ items: readonly PlanWalk[]; notice: string }> {
    const region = await this.regionOf(query);
    const courses = await this.courses();
    const items = (courses ?? [])
      .filter((c) => isCourseInRegion(c.sigun, { ...query, signguName: region.signguName }))
      .map(toWalk)
      .filter((w) => w.walkId !== '' && w.name !== '');
    return { items, notice: '넣으면 직접 정한 곳으로 들어가요.' };
  }

  /**
   * 카드 「자세히」 — 그 콘텐츠의 이용시간 · 쉬는 날 · 요금 · 주차 · 행사 기간 (FR-PL-012).
   * `detailIntro2` 1콜을 그때그때 실호출한다(캐시 없음). 소개정보를 못 받으면 값은 비운다.
   * 예산은 국문 관광정보와 같은 문이다 — 100% 면 429 로 막는다 (FR-PL-018).
   */
  async placeDetail(query: PlaceDetailQuery): Promise<PlaceDetailResult> {
    await this.assertKorBudget();
    let intro: Record<string, unknown> | null = null;
    try {
      intro = await this.kto().detailIntro(query.contentId, query.contentTypeId as ContentTypeId);
    } catch (e) {
      if (!isKtoError(e)) throw e;
      // 소개정보를 못 받아도 카드는 열린다 — 값만 비운다 (EX-PL-004 와 같은 결)
      intro = null;
    }
    const fields = intro === null ? null : factFields(query.contentTypeId, intro);
    return {
      contentId: query.contentId,
      hours: fields?.hours ?? null,
      restDays: fields?.restDays ?? null,
      fee: fields?.fee ?? null,
      parking: fields?.parking ?? null,
      eventPeriod: fields?.eventPeriod ?? null,
    };
  }

  // ── 시군구 전체 ─────────────────────────────────────────────────

  private async signguPlaces(query: PlacesQuery): Promise<PlacesResult> {
    await this.assertKorBudget();
    const lcls2 = query.lcls2;
    if (lcls2 === null) {
      throw new DomainException(HttpStatus.BAD_REQUEST, 'INPUT_INVALID', '종류를 골라 주세요.', 'REQUEST');
    }
    const region = await this.regionOf(query);
    const page = await this.cache.getOrLoad(`list:${regionKey(query)}:${lcls2}`, async () =>
      this.allPlacePages('areaBasedList2', (pageNo) => this.kto().areaBasedList({
        ...ldongParams(query),
        lclsSystm2: lcls2,
        numOfRows: PLAN_LIST_ROWS,
        pageNo,
      })));

    const [accessible, pet] = await Promise.all([
      this.contentIdSet(query, 'WITH'),
      this.contentIdSet(query, 'PET'),
    ]);
    let places: readonly PlanPlace[] = visibleItems(page).map((item) => toPlace(item, { accessible, pet }));
    let notice = accessible === null || pet === null ? PARTIAL_NOTICE : null;

    if (query.sort === 'near' && query.anchor !== null) {
      places = await this.sortByDistance(places, query.anchor);
    }
    if (query.sort === 'together') {
      const ranked = await this.rankTogether(places, query);
      places = ranked.places;
      notice = ranked.notice ?? notice;
    }

    const filtered = places.filter((p) => matchesFilters(p, query));
    return {
      scope: { kind: query.sort === 'near' && query.anchor !== null ? 'NEAR' : 'SIGNGU', label: scopeLabel(query, region) },
      totalCount: filtered.length,
      items: pageOf(filtered, query.page),
      disabled: null,
      notice,
    };
  }

  /** 가까운 순 — 반경 20km 조회의 `dist` 를 붙인다. 그 안에 없으면 거리 없음으로 뒤에 둔다 */
  private async sortByDistance(
    places: readonly PlanPlace[],
    anchor: { mapx: number; mapy: number },
  ): Promise<readonly PlanPlace[]> {
    const distances = await this.distancesAround(anchor, PLAN_SORT_NEAR_RADIUS_M, null);
    if (distances === null) return places;
    return [...places]
      .map((p) => ({ ...p, distanceM: distances.get(p.contentId) ?? null }))
      .sort(byDistance);
  }

  /**
   * 함께 많이 가는 순 (EI-KT-024).
   *
   * 연관 관광지 응답에는 국문 `contentid` 가 없다. 기준 관광지 이름이 앵커와 같은 줄만 쓰고,
   * 연관 관광지 이름 · 시군구가 목록의 **한 곳과만** 맞을 때 순위를 붙인다. 여럿이거나 없으면
   * 순위 없이 둔다 — 짐작으로 붙이면 다른 곳의 순위가 이 곳에 달린다 (설계 원칙 3).
   */
  private async rankTogether(
    places: readonly PlanPlace[],
    query: PlacesQuery,
  ): Promise<{ places: readonly PlanPlace[]; notice: string | null }> {
    const anchorName = await this.anchorName(query, places);
    const signguCd = query.signguCd === null ? query.regnCd : `${query.regnCd}${query.signguCd}`;
    if (anchorName === null || !/^\d{5}$/.test(signguCd)) {
      return { places, notice: '기준이 될 장소를 먼저 고르면 함께 많이 가는 순으로 볼 수 있습니다.' };
    }

    let rows: readonly Record<string, unknown>[];
    try {
      const decision = await this.budget('RELATED');
      if (!decision.allowed) return { places, notice: PARTIAL_NOTICE };
      const page = await this.kto().relatedSearchKeyword({
        keyword: anchorName,
        baseYm: relatedBaseYm(),
        areaCd: query.regnCd.slice(0, 2),
        signguCd,
      });
      rows = page.items;
    } catch (e) {
      if (!isKtoError(e)) throw e;
      return { places, notice: PARTIAL_NOTICE };
    }

    const ranks = new Map<string, number>();
    for (const row of rows) {
      // 기준 관광지가 앵커와 같은 줄만, 분류가 관광지인 줄만 쓴다
      if (String(row.tAtsNm ?? '') !== anchorName) continue;
      if (String(row.rlteCtgryLclsNm ?? '') !== '관광지') continue;
      const name = String(row.rlteTatsNm ?? '');
      const rank = Number(row.rlteRank);
      const matched = places.filter((p) => p.title === name);
      if (matched.length !== 1 || !Number.isFinite(rank)) continue;
      const only = matched[0];
      if (only !== undefined) ranks.set(only.contentId, rank);
    }

    const ranked = places
      .map((p) => ({ ...p, togetherRank: ranks.get(p.contentId) ?? null }))
      .sort((a, b) => (a.togetherRank ?? Number.MAX_SAFE_INTEGER) - (b.togetherRank ?? Number.MAX_SAFE_INTEGER));
    return { places: ranked, notice: null };
  }

  /** 앵커 이름 — 목록에 있으면 그것을 쓰고, 없으면 공통정보 1콜로 확인한다 */
  private async anchorName(query: PlacesQuery, places: readonly PlanPlace[]): Promise<string | null> {
    const contentId = query.anchorContentId;
    if (contentId === null) return null;
    const found = places.find((p) => p.contentId === contentId);
    if (found !== undefined) return found.title;
    try {
      const item = await this.kto().detailCommon(contentId);
      const title = String(item.title ?? '').trim();
      return title === '' ? null : title;
    } catch (e) {
      if (!isKtoError(e)) throw e;
      return null;
    }
  }

  // ── 근처 3km ────────────────────────────────────────────────────

  private async nearPlaces(query: PlacesQuery): Promise<PlacesResult> {
    const nearKind = query.nearKind;
    if (nearKind === null) {
      throw new DomainException(HttpStatus.BAD_REQUEST, 'INPUT_INVALID', '종류를 골라 주세요.', 'REQUEST');
    }
    // 앵커가 없으면 부르지 않는다 — 기준이 없으면 반경을 잡을 수 없다 (EX-PL-008)
    if (query.anchor === null) {
      return {
        scope: { kind: 'NEAR3KM', label: '넣을 위치 근처 3km' },
        totalCount: 0,
        items: [],
        disabled: 'ANCHOR_REQUIRED',
        notice: '앞에 고른 장소가 있어야 근처를 볼 수 있습니다.',
      };
    }
    await this.assertKorBudget();

    const lcls1 = PLAN_NEAR_KIND[nearKind].lcls1;
    const page = await this.cache.getOrLoad(`near:${anchorKey(query.anchor)}:${lcls1}`, async () =>
      this.allPlacePages('locationBasedList2', (pageNo) => this.kto().locationBasedList({
        mapX: query.anchor?.mapx ?? 0,
        mapY: query.anchor?.mapy ?? 0,
        radius: PLAN_NEAR_RADIUS_M,
        lclsSystm1: lcls1,
        numOfRows: PLAN_NEAR_ROWS,
        pageNo,
      })));

    const [accessible, pet] = await Promise.all([
      this.contentIdSet(query, 'WITH'),
      this.contentIdSet(query, 'PET'),
    ]);
    const places = visibleItems(page)
      .map((item) => toPlace(item, { accessible, pet }))
      // 식당은 주점 · 카페를 빼고, 카페는 FD05 만, 숙소는 AC 다 (PLAN_NEAR_KIND)
      .filter((p) => matchesNearKind(nearKind, p.lcls1, p.lcls2))
      .filter((p) => matchesFilters(p, query))
      // 응답이 거리순으로 오지 않는다 (2026.09.15 실호출)
      .sort(byDistance);

    return {
      scope: { kind: 'NEAR3KM', label: '넣을 위치 근처 3km' },
      totalCount: places.length,
      items: pageOf(places, query.page),
      disabled: null,
      notice: accessible === null || pet === null ? PARTIAL_NOTICE : null,
    };
  }

  // ── 조회 조각 ───────────────────────────────────────────────────

  /** 전체 원본을 받은 뒤 정렬·필터·화면 페이징한다. 부분 결과는 캐시하지 않는다. */
  private async allPlacePages(
    operation: 'areaBasedList2' | 'locationBasedList2',
    load: (pageNo: number) => Promise<KtoListPage>,
  ): Promise<KtoListPage> {
    const first = await load(1);
    const items = new Map(first.items.map((item) => [String(item.contentid), item]));
    let received = first.items.length;
    for (let pageNo = 2; first.totalCount !== null && received < first.totalCount; pageNo++) {
      await this.assertKorBudget();
      const last = await load(pageNo);
      const before = items.size;
      for (const item of last.items) items.set(String(item.contentid), item);
      if (last.items.length === 0 || items.size === before) {
        throw new KtoFetchError(operation, '장소 목록의 다음 페이지를 받지 못했습니다. 다시 시도해 주세요.');
      }
      received += last.items.length;
    }
    return { ...first, items: [...items.values()] };
  }

  /** 중분류 등록 수 — 목록과 같은 조건으로 `numOfRows=1` 1콜 (D6) */
  private async countOf(region: PlanRegion, lcls2: string): Promise<number | null> {
    return this.cache.getOrLoad(`count:${regionKey(region)}:${lcls2}`, async () => {
      try {
        const page = await this.kto().areaBasedList({ ...ldongParams(region), lclsSystm2: lcls2, numOfRows: 1, pageNo: 1 });
        return page.totalCount;
      } catch (e) {
        if (!isKtoError(e)) throw e;
        return null;
      }
    });
  }

  /** 여행 기간 ±3일에 열리는 행사 수 (FR-PL-014 와 같은 창) */
  private async eventCount(
    region: PlanRegion,
    window: { from: string; to: string },
  ): Promise<{ count: number; from: string; to: string } | null> {
    return this.cache.getOrLoad(`events:${regionKey(region)}:${window.from}:${window.to}`, async () => {
      try {
        const page = await this.kto().searchFestival({
          // 창의 시작일로 부르면 그날 아직 끝나지 않은 행사가 함께 온다 (EI-KT-010)
          eventStartDate: window.from.replace(/-/g, ''),
          ...ldongParams(region),
          numOfRows: PLAN_LIST_ROWS,
        });
        const count = visibleItems(page).filter((item) => overlaps(item, window)).length;
        return { count, from: window.from, to: window.to };
      } catch (e) {
        if (!isKtoError(e)) throw e;
        return null;
      }
    });
  }

  /** 상품 지역의 걷기 길 수 (EI-KT-025). 전국 목록 1콜을 `sigun` 글자로 거른다 */
  private async walkCount(region: PlanRegion, signguName: string | null): Promise<{ count: number } | null> {
    const courses = await this.courses();
    if (courses === null) return null;
    return { count: courses.filter((c) => isCourseInRegion(c.sigun, { ...region, signguName })).length };
  }

  private async courses(): Promise<readonly Record<string, unknown>[] | null> {
    return this.cache.getOrLoad('walks:all', async () => {
      try {
        const decision = await this.budget('DURUNUBI');
        if (!decision.allowed) return null;
        return (await this.kto().courseList()).items;
      } catch (e) {
        if (!isKtoError(e)) throw e;
        return null;
      }
    });
  }

  /**
   * 무장애 · 반려동물 `contentid` 집합 (EI-KT-022 · 023). 지역 목록 1콜이고 10분만 들고 있는다.
   * 못 받으면 `null` — 화면은 「모름」으로 두고 필터를 걸지 않는다.
   */
  private async contentIdSet(region: PlanRegion, service: 'WITH' | 'PET'): Promise<ReadonlySet<string> | null> {
    if (region.signguCd === null) return null;
    return this.cache.getOrLoad(`${service}:${regionKey(region)}`, async () => {
      try {
        const decision = await this.budget(service);
        if (!decision.allowed) return null;
        const params = { lDongRegnCd: region.regnCd, lDongSignguCd: region.signguCd ?? '' };
        const page = service === 'WITH'
          ? await this.kto().withAreaBasedList(params)
          : await this.kto().petAreaBasedList(params);
        return new Set(page.items.map((i) => String(i.contentid ?? '')).filter((id) => id !== ''));
      } catch (e) {
        if (!isKtoError(e)) throw e;
        this.logger.warn(`${service} 지역 목록을 못 받았다 — 그 필터는 모름으로 둔다`);
        return null;
      }
    });
  }

  /** 반경 안 거리표. 실패하면 `null` — 거리를 지어내지 않는다 */
  private async distancesAround(
    anchor: { mapx: number; mapy: number },
    radius: number,
    lcls1: string | null,
  ): Promise<ReadonlyMap<string, number> | null> {
    try {
      const page = await this.cache.getOrLoad(`dist:${anchorKey(anchor)}:${radius}:${lcls1 ?? ''}`, async () =>
        this.kto().locationBasedList({
          mapX: anchor.mapx,
          mapY: anchor.mapy,
          radius,
          ...(lcls1 === null ? {} : { lclsSystm1: lcls1 }),
          numOfRows: PLAN_NEAR_ROWS,
          pageNo: 1,
        }));
      const out = new Map<string, number>();
      for (const item of page.items) {
        const dist = Number(item.dist);
        if (Number.isFinite(dist)) out.set(String(item.contentid ?? ''), Math.round(dist));
      }
      return out;
    } catch (e) {
      if (!isKtoError(e)) throw e;
      return null;
    }
  }

  /** 지역 이름 — 법정동 코드표에서 찾는다. 코드표는 원문이 아니라 캐시해도 된다 */
  private async regionOf(region: PlanRegion): Promise<{ name: string; signguName: string | null }> {
    const signguName = await this.cache.getOrLoad(`region:${regionKey(region)}`, async () => {
      try {
        if (region.signguCd === null) {
          const sido = await this.kto().ldongCode();
          return nameOf(sido, region.regnCd);
        }
        const signgus = await this.kto().ldongCode(region.regnCd);
        return nameOf(signgus, region.signguCd);
      } catch (e) {
        if (!isKtoError(e)) throw e;
        return null;
      }
    });
    return { name: signguName ?? '', signguName };
  }

  /** 국문 관광정보 예산 — 여기서 막히면 기획 조회 자체가 429 다 (D2 · EI-CM-012) */
  private async assertKorBudget(): Promise<void> {
    const decision = await this.budget('KOR');
    if (!decision.allowed) {
      throw new DomainException(HttpStatus.TOO_MANY_REQUESTS, 'BUDGET_EXHAUSTED', BUDGET_MESSAGE, 'REQUEST');
    }
  }

  private async budgetState(): Promise<'OK' | 'WARN' | 'PAUSED'> {
    const decision = await this.budget('KOR');
    if (!decision.allowed) return 'PAUSED';
    return decision.warn ? 'WARN' : 'OK';
  }
}

/** 첫째 줄 칩의 중분류 — 기본 4 + "자주 넣는 곳"에서 연 종류. 음식 · 숙박 · 추천코스는 뺀다 */
export function chipCodes(extraLcls2: readonly string[]): readonly string[] {
  const excluded = PLAN_EXCLUDED_LCLS1 as readonly string[];
  const extra = extraLcls2.filter((code) => code in LCLS_SYSTM2 && !excluded.includes(LCLS_SYSTM2[code]?.parent ?? ''));
  return [...new Set([...PLAN_BASE_LCLS2, ...extra])];
}

/** 축제 · 공연 창 — 여행 기간 앞뒤 3일 (FR-PL-014 · T2 와 같은 창) */
export function eventWindow(startDate: string, nights: number): { from: string; to: string } | null {
  const start = parseIsoDate(startDate);
  if (start === null || !Number.isInteger(nights) || nights < 0) return null;
  return { from: formatIsoDate(addDays(start, -3)), to: formatIsoDate(addDays(start, nights + 3)) };
}

/**
 * 행사 한 줄 → 축제 카드. 기간을 모르는 행사는 넣지 않는다 (모르는 건 모른다고 둔다).
 *
 * `relation` 은 여행 기간과의 관계 표시다 — `IN` 은 하루라도 겹치는 것이고, `AFTER` 는 여행이
 * 끝난 뒤 시작, `BEFORE` 는 여행 전에 끝나는 것이다.
 */
function toEvent(item: Record<string, unknown>, query: BriefingQuery): PlanEvent | null {
  const eventStart = isoDay(item.eventstartdate);
  const eventEnd = isoDay(item.eventenddate);
  if (eventStart === null || eventEnd === null) return null;

  const tripEnd = tripLastDay(query);
  const relation: PlanEvent['relation'] = eventEnd < query.startDate ? 'BEFORE'
    : tripEnd !== null && eventStart > tripEnd ? 'AFTER' : 'IN';
  return {
    contentId: String(item.contentid ?? ''),
    contentTypeId: Number(item.contenttypeid ?? 15),
    title: String(item.title ?? ''),
    eventStart,
    eventEnd,
    relation,
    // 겹치지 않는 행사만 옮길 출발일을 제안한다. 겹치면 옮길 이유가 없다
    suggestedStartDate: relation === 'IN' ? null : eventStart,
    firstImage: text(item.firstimage),
    mapx: numberOrNull(item.mapx),
    mapy: numberOrNull(item.mapy),
  };
}

/** 여행 마지막 날. 밤 수가 없으면 출발일 하나다 */
function tripLastDay(query: BriefingQuery): string | null {
  const start = parseIsoDate(query.startDate);
  return start === null ? null : formatIsoDate(addDays(start, query.nights));
}

/** 창과 겹치거나 창 뒤에 시작하는 행사. 창 전에 끝난 것은 목록에 넣지 않는다 */
function overlapsOrLater(item: Record<string, unknown>, window: { from: string; to: string }): boolean {
  const end = isoDay(item.eventenddate);
  return end !== null && end >= window.from;
}

/** 목록 한 줄 → 장소 카드. 제목 · 주소 · 사진은 응답으로만 흐른다 */
function toPlace(
  item: Record<string, unknown>,
  sets: { accessible: ReadonlySet<string> | null; pet: ReadonlySet<string> | null },
): PlanPlace {
  const contentId = String(item.contentid ?? '');
  const lcls2 = String(item.lclsSystm2 ?? '');
  const dist = Number(item.dist);
  return {
    contentId,
    contentTypeId: Number(item.contenttypeid ?? 0),
    lcls1: String(item.lclsSystm1 ?? ''),
    lcls2,
    lcls2Name: LCLS_SYSTM2[lcls2]?.name ?? '',
    title: String(item.title ?? ''),
    addr1: text(item.addr1),
    firstImage: text(item.firstimage),
    mapx: numberOrNull(item.mapx),
    mapy: numberOrNull(item.mapy),
    distanceM: Number.isFinite(dist) ? Math.round(dist) : null,
    togetherRank: null,
    // 집합을 못 받았으면 「아니다」가 아니라 「모른다」다 (EX-PL-004)
    wheelchair: sets.accessible === null ? null : sets.accessible.has(contentId),
    pet: sets.pet === null ? null : sets.pet.has(contentId),
    indoorOutdoor: INDOOR_OUTDOOR_SEED[lcls2] ?? null,
  };
}

/** 비표출(`showflag` 0)은 뺀다. 값이 없으면 표출로 본다 — 목록 응답에 없을 수 있다 */
function visibleItems(page: KtoListPage): readonly Record<string, unknown>[] {
  return page.items.filter((item) => item.showflag === undefined || String(item.showflag) !== '0');
}

function matchesFilters(place: PlanPlace, query: PlacesQuery): boolean {
  // 모르는 것(null)을 「아니다」로 읽지 않는다 — 필터를 켜면 확인된 곳만 남는다
  if (query.wheelchair && place.wheelchair !== true) return false;
  if (query.pet && place.pet !== true) return false;
  if (query.indoor && place.indoorOutdoor !== 'INDOOR') return false;
  return true;
}

function byDistance(a: PlanPlace, b: PlanPlace): number {
  return (a.distanceM ?? Number.MAX_SAFE_INTEGER) - (b.distanceM ?? Number.MAX_SAFE_INTEGER);
}

function overlaps(item: Record<string, unknown>, window: { from: string; to: string }): boolean {
  const start = isoDay(item.eventstartdate);
  const end = isoDay(item.eventenddate);
  // 기간을 모르는 행사는 세지 않는다 (FR-RU-120 과 같은 원칙)
  if (start === null || end === null) return false;
  return start <= window.to && end >= window.from;
}

function pageOf(places: readonly PlanPlace[], page: number): readonly PlanPlace[] {
  const from = Math.max(0, page - 1) * PLAN_PAGE_SIZE;
  return places.slice(from, from + PLAN_PAGE_SIZE);
}

function scopeLabel(query: PlacesQuery, region: { name: string }): string {
  if (query.sort === 'near' && query.anchor !== null) return '시군구 전체 · 고른 줄에서 가까운 순';
  return region.name === '' ? '전체' : `${region.name} 전체`;
}

/** 연관 관광지 기준 연월 — 자료가 한 달 늦게 올라와 지난달로 부른다 (2026.09.15 실호출) */
export function relatedBaseYm(now: Date = new Date()): string {
  const kst = new Date(now.getTime() + 9 * 60 * 60_000);
  kst.setUTCDate(1);
  kst.setUTCMonth(kst.getUTCMonth() - 1);
  return `${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, '0')}`;
}

function ldongParams(region: PlanRegion): { lDongRegnCd: string; lDongSignguCd?: string } {
  return {
    lDongRegnCd: region.regnCd,
    ...(region.signguCd === null ? {} : { lDongSignguCd: region.signguCd }),
  };
}

function regionKey(region: PlanRegion): string {
  return `${region.regnCd}:${region.signguCd ?? ''}`;
}

/** 앵커는 소수 셋째 자리까지만 캐시 키로 쓴다 — 100m 안쪽이면 같은 조회다 */
function anchorKey(anchor: { mapx: number; mapy: number }): string {
  return `${anchor.mapx.toFixed(3)},${anchor.mapy.toFixed(3)}`;
}

function nameOf(page: KtoListPage, code: string): string | null {
  const found = page.items.find((i) => String(i.code ?? '') === code);
  return found === undefined ? null : String(found.name ?? '');
}

function text(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return s === '' ? null : s;
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoDay(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  return /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : null;
}
