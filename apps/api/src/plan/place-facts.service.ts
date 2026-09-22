import { HttpStatus, Logger } from '@nestjs/common';
import {
  CONTENT_TYPE_ID,
  INTRO_FIELDS,
  LCLS_SYSTM2,
  type ContentTypeId,
  type ItemMatchedBy,
  type ItemOrigin,
  type PlaceFacts,
  type Transport,
} from '@tourlint/shared';
import { DomainException } from '../common/domain.exception';
import { addDays, formatIsoDate, parseIsoDate } from '../engine/calendar/dates';
import { normalizeLineBreaks } from '../engine/normalize/preprocess';
import { departureStamp } from '../audit/audit-runner';
import type { PlaceNameResolver } from '../audit/place-name';
import type { KakaoMobilityClient } from '../external/kakao';
import { isKtoError, type KtoClient } from '../external/kto';
import { PlanCache } from './plan-cache';
import type { PlanItem, PlanItemRepository, PlanProduct } from './plan-item.repository';
import type { PlanBudget } from './plan.service';
import { coordinateOf, estimateTravelMinutes } from './travel-estimate';

/**
 * 장소 정보 한 줄 (FR-PL-005 · API 4-10 `place-facts`).
 *
 * 고른 항목의 **사실만** 보인다 — 이용시간 · 쉬는 날 · 요금 · 주차 · 행사 기간과 앞 항목에서
 * 차로 걸리는 시간이다. 규칙 함수를 부르지 않고 `audit_run` · `finding` · `content_fingerprint` 를
 * 만들지 않는다. 판정은 검수 시작 창을 지난 뒤의 일이다 (FR-PL-021).
 *
 * 값은 공사 원문이라 **응답으로만** 흐른다 (DB 명세서 6-4). 같은 항목을 다시 열면 10분 캐시가
 * 받아 준다.
 */

export interface PlaceFactsServiceOptions {
  readonly items: PlanItemRepository;
  readonly kto: () => KtoClient;
  readonly kakao: () => KakaoMobilityClient | null;
  readonly budget: PlanBudget;
  /** 장소명을 저장하지 않는 항목(고른 곳)의 이름을 표시할 때 찾는다 (DR-PR-001) */
  readonly names: PlaceNameResolver;
  readonly cache?: PlanCache;
}

/** 유형별 요금 · 주차 필드. 이용시간 · 쉬는 날은 `INTRO_FIELDS`(엔진과 같은 표)를 쓴다 */
const FEE_PARKING: Readonly<Record<ContentTypeId, { fee: string | null; parking: string | null }>> = {
  12: { fee: null, parking: 'parking' },
  14: { fee: 'usefee', parking: 'parkingculture' },
  // 축제는 이용요금이 `usetimefestival` 이고 주차 정보가 따로 없다 (2026.08 실호출 스냅샷)
  15: { fee: 'usetimefestival', parking: null },
  28: { fee: 'usefeeleports', parking: 'parkingleports' },
  32: { fee: null, parking: 'parkinglodging' },
  38: { fee: null, parking: 'parkingshopping' },
  39: { fee: null, parking: 'parkingfood' },
};

const BUDGET_MESSAGE =
  '오늘 쓸 수 있는 관광정보 조회를 모두 썼습니다. 내일 0시부터 다시 볼 수 있고, 일정 입력과 저장은 지금도 할 수 있습니다.';

export class PlaceFactsService {
  private readonly logger = new Logger(PlaceFactsService.name);
  private readonly items: PlanItemRepository;
  private readonly kto: () => KtoClient;
  private readonly kakao: () => KakaoMobilityClient | null;
  private readonly budget: PlanBudget;
  private readonly names: PlaceNameResolver;
  private readonly cache: PlanCache;

  constructor(options: PlaceFactsServiceOptions) {
    this.items = options.items;
    this.kto = options.kto;
    this.kakao = options.kakao;
    this.budget = options.budget;
    this.names = options.names;
    this.cache = options.cache ?? new PlanCache();
  }

  /**
   * 고른 항목의 장소 정보. `itemIds` 를 주면 그것만, 안 주면 고른 항목 전부다.
   *
   * 고르지 않은 줄(`PENDING`)과 직접 정한 곳(`EXCLUDED`)은 넣지 않는다 — 공사 정보가 없는 줄에
   * 「정보 없음」을 적으면 고른 곳과 구분이 사라진다 (UI-S2-035).
   */
  async factsOf(accountId: number, productId: number, itemIds: readonly number[] | null): Promise<readonly PlaceFacts[]> {
    const product = await this.items.product(accountId, productId);
    if (product === null) {
      throw new DomainException(
        HttpStatus.NOT_FOUND, 'NOT_FOUND', '상품을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.',
      );
    }
    const wanted = product.items.filter((item) =>
      item.matchStatus === 'CONFIRMED'
      && item.contentId !== null
      && (itemIds === null || itemIds.includes(item.id)));
    if (wanted.length === 0) return [];

    const decision = await this.budget('KOR');
    if (!decision.allowed) {
      throw new DomainException(HttpStatus.TOO_MANY_REQUESTS, 'BUDGET_EXHAUSTED', BUDGET_MESSAGE, 'REQUEST');
    }

    // 장소명을 저장하지 않은 항목만 이름을 찾는다. 이미 입력된 이름은 그대로 쓴다
    const missing = wanted.filter((i) => i.placeLabel === null).map((i) => i.contentId ?? '');
    const names = missing.length === 0 ? new Map<string, string>() : await this.names.resolve(missing);

    const out: PlaceFacts[] = [];
    for (const item of wanted) {
      out.push(await this.factsOfItem(product, item, names));
    }
    return out;
  }

  private async factsOfItem(
    product: PlanProduct,
    item: PlanItem,
    names: ReadonlyMap<string, string>,
  ): Promise<PlaceFacts> {
    const intro = await this.intro(item);
    const fields = intro === null ? null : factFields(item.contentTypeId, intro);
    return {
      itemId: item.id,
      name: item.placeLabel ?? names.get(item.contentId ?? '') ?? '',
      kindName: item.lcls2 === null ? '' : LCLS_SYSTM2[item.lcls2]?.name ?? '',
      hours: fields?.hours ?? null,
      restDays: fields?.restDays ?? null,
      fee: fields?.fee ?? null,
      parking: fields?.parking ?? null,
      eventPeriod: fields?.eventPeriod ?? null,
      travelFromPrevMinutes: await this.travelFromPrev(product, item),
      matchedBy: item.matchedBy as ItemMatchedBy | null,
      origin: item.origin as ItemOrigin | null,
    };
  }

  /** 소개정보 1콜. 유형을 함께 넘겨야 유형별 필드가 채워져 온다 (EI-KT). 실패하면 `null` */
  private async intro(item: PlanItem): Promise<Record<string, unknown> | null> {
    const contentId = item.contentId;
    const contentTypeId = item.contentTypeId;
    if (contentId === null || contentTypeId === null) return null;
    if (!(CONTENT_TYPE_ID as readonly number[]).includes(contentTypeId)) return null;

    return this.cache.getOrLoad(`intro:${contentId}:${contentTypeId}`, async () => {
      try {
        return await this.kto().detailIntro(contentId, contentTypeId as ContentTypeId);
      } catch (e) {
        if (!isKtoError(e)) throw e;
        this.logger.warn(`소개정보를 못 받았다 — 그 줄의 값은 비운다 (item ${item.id})`);
        return null;
      }
    });
  }

  /**
   * 앞 항목에서 차로 걸리는 시간 (FR-PL-005).
   *
   * 앞 항목이 없거나 직접 정한 곳이거나 좌표가 없으면 `null` 이다 — 없는 구간의 시간을 지어내지
   * 않는다 (EX-PL-006). 대중교통 상품도 `null` 이다.
   */
  private async travelFromPrev(product: PlanProduct, item: PlanItem): Promise<number | null> {
    const prev = previousItem(product.items, item);
    if (prev === null || prev.matchStatus !== 'CONFIRMED') return null;

    const start = parseIsoDate(product.startDate);
    const departureAt = start === null || prev.endTime === null
      ? null
      : departureStamp(formatIsoDate(addDays(start, prev.dayNo - 1)), prev.endTime);

    return estimateTravelMinutes({
      kakao: this.kakao(),
      from: coordinateOf(prev.mapx, prev.mapy),
      to: coordinateOf(item.mapx, item.mapy),
      transport: product.transport as Transport,
      departureAt,
    });
  }
}

/** 같은 날의 바로 앞 줄. 날이 바뀌면 앞 구간이 아니다 — 자고 일어난 뒤의 이동이다 */
export function previousItem(items: readonly PlanItem[], item: PlanItem): PlanItem | null {
  const sameDay = items.filter((i) => i.dayNo === item.dayNo && i.seq < item.seq);
  return sameDay.length === 0 ? null : (sameDay[sameDay.length - 1] ?? null);
}

/** 숙박 소개정보의 두 시각이 각각 무엇인지 */
const STAY_LABEL: Readonly<Record<string, string>> = { checkintime: '입실', checkouttime: '퇴실' };

/** 소개정보 응답 → 화면에 그대로 적는 값들. 유형마다 필드 이름이 다르다 (외부 연동 3-3 분기표) */
export function factFields(
  contentTypeId: number | null,
  intro: Record<string, unknown>,
): { hours: string | null; restDays: string | null; fee: string | null; parking: string | null; eventPeriod: string | null } {
  const type = contentTypeId as ContentTypeId | null;
  const known = type !== null && (CONTENT_TYPE_ID as readonly number[]).includes(type);
  const intoFields = known ? INTRO_FIELDS[type] : null;
  const feeParking = known ? FEE_PARKING[type] : null;

  return {
    // 숙박은 입실 · 퇴실 두 값을 함께 적는다. 무엇인지 붙이지 않으면 「이용시간 15:00 · 11:00」 이 된다 (#730)
    hours: joinText((intoFields?.use ?? []).map((field) => {
      const value = text(intro[field]);
      const label = STAY_LABEL[field];
      return value === null || label === undefined ? value : `${label} ${value}`;
    })),
    restDays: intoFields?.rest === null || intoFields?.rest === undefined ? null : text(intro[intoFields.rest]),
    fee: feeParking?.fee === null || feeParking?.fee === undefined ? null : text(intro[feeParking.fee]),
    parking: feeParking?.parking === null || feeParking?.parking === undefined ? null : text(intro[feeParking.parking]),
    eventPeriod: eventPeriod(intro),
  };
}

/** 행사 기간 — 축제 · 공연 소개정보에만 있다 */
function eventPeriod(intro: Record<string, unknown>): string | null {
  const from = day(intro.eventstartdate);
  const to = day(intro.eventenddate);
  return from === null || to === null ? null : `${from} ~ ${to}`;
}

function joinText(values: readonly (string | null)[]): string | null {
  const kept = values.filter((v): v is string => v !== null);
  return kept.length === 0 ? null : kept.join(' · ');
}

/** 화면에 적을 글자. 원문의 `<br>` 은 개행으로 — 엔진이 해석 입력에 하는 것과 같은 처리다 (#762) */
function text(value: unknown): string | null {
  const s = normalizeLineBreaks(String(value ?? '')).trim();
  return s === '' ? null : s;
}

function day(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  return /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : null;
}
