import { BadRequestException } from '@nestjs/common';
import { CONTENT_TYPE_ID, PLAN_NEAR_KIND, type PlanNearKind } from '@tourlint/shared';
import type { BriefingQuery, PlaceDetailQuery, PlacesQuery } from './plan.service';

/**
 * 기획 조회 질의 읽기 (API 4-10).
 *
 * **모양이 아니면 기본값으로 떨어뜨리지 않고 튕긴다.** 조용히 다른 지역 · 다른 종류를 세면
 * 화면은 자기가 요청한 것을 받은 줄 안다 (`usage` 컨트롤러와 같은 이유).
 */

export interface RawBriefingQuery {
  regnCd?: string;
  signguCd?: string;
  startDate?: string;
  nights?: string;
  extraLcls2?: string;
}

export function readBriefingQuery(raw: RawBriefingQuery): BriefingQuery {
  return {
    ...readRegion(raw),
    startDate: readDate(raw.startDate),
    nights: readNights(raw.nights),
    extraLcls2: (raw.extraLcls2 ?? '').split(',').map((s) => s.trim()).filter((s) => s !== ''),
  };
}

export interface RawPlacesQuery {
  regnCd?: string;
  signguCd?: string;
  scope?: string;
  lcls2?: string;
  nearKind?: string;
  sort?: string;
  anchor?: string;
  anchorContentId?: string;
  wheelchair?: string;
  pet?: string;
  indoor?: string;
  page?: string;
}

export function readPlacesQuery(raw: RawPlacesQuery): PlacesQuery {
  const scope = raw.scope === undefined || raw.scope === '' ? 'SIGNGU' : raw.scope;
  if (scope !== 'SIGNGU' && scope !== 'NEAR3KM') {
    throw new BadRequestException('scope 는 SIGNGU 또는 NEAR3KM 이어야 합니다.');
  }
  const nearKind = readNearKind(raw.nearKind);
  if (scope === 'NEAR3KM' && nearKind === null) {
    throw new BadRequestException(`nearKind 는 ${Object.keys(PLAN_NEAR_KIND).join(' · ')} 중 하나여야 합니다.`);
  }
  return {
    ...readRegion(raw),
    scope,
    lcls2: raw.lcls2 === undefined || raw.lcls2 === '' ? null : raw.lcls2,
    nearKind,
    sort: readSort(raw.sort),
    anchor: readAnchor(raw.anchor),
    anchorContentId: raw.anchorContentId === undefined || raw.anchorContentId === '' ? null : raw.anchorContentId,
    wheelchair: raw.wheelchair === '1',
    pet: raw.pet === '1',
    indoor: raw.indoor === '1',
    page: readPage(raw.page),
  };
}

export interface RawPlaceDetailQuery {
  contentId?: string;
  contentTypeId?: string;
}

/** 카드 「자세히」 조회 — contentId 와 지원 유형(contentTypeId)이 있어야 한다 */
export function readPlaceDetailQuery(raw: RawPlaceDetailQuery): PlaceDetailQuery {
  const contentId = (raw.contentId ?? '').trim();
  if (contentId === '') throw new BadRequestException('contentId 가 필요합니다.');
  const contentTypeId = Number(raw.contentTypeId);
  if (!Number.isInteger(contentTypeId) || !(CONTENT_TYPE_ID as readonly number[]).includes(contentTypeId)) {
    throw new BadRequestException(`contentTypeId 는 ${CONTENT_TYPE_ID.join(' · ')} 중 하나여야 합니다.`);
  }
  return { contentId, contentTypeId };
}

/** 지역만 받는 조회(걷기 길) */
export function readRegionQuery(raw: { regnCd?: string; signguCd?: string }): { regnCd: string; signguCd: string | null } {
  return readRegion(raw);
}

function readRegion(raw: { regnCd?: string; signguCd?: string }): { regnCd: string; signguCd: string | null } {
  const regnCd = raw.regnCd ?? '';
  // 세종(36110)은 시도 코드가 다섯 자리이고 시군구 단계가 없다
  if (!/^\d{2}(?:\d{3})?$/.test(regnCd)) throw new BadRequestException('regnCd 는 시도 코드여야 합니다.');
  const signguCd = raw.signguCd === undefined || raw.signguCd === '' ? null : raw.signguCd;
  if (signguCd !== null && !/^\d{3}$/.test(signguCd)) {
    throw new BadRequestException('signguCd 는 시군구 코드 3자리여야 합니다.');
  }
  return { regnCd, signguCd };
}

function readDate(value: string | undefined): string {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException('startDate 는 YYYY-MM-DD 형식이어야 합니다.');
  }
  return value;
}

function readNights(value: string | undefined): number {
  const n = value === undefined || value === '' ? 0 : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 30) throw new BadRequestException('nights 는 0 이상 30 이하 정수여야 합니다.');
  return n;
}

function readNearKind(value: string | undefined): PlanNearKind | null {
  if (value === undefined || value === '') return null;
  if (!(value in PLAN_NEAR_KIND)) {
    throw new BadRequestException(`nearKind 는 ${Object.keys(PLAN_NEAR_KIND).join(' · ')} 중 하나여야 합니다.`);
  }
  return value as PlanNearKind;
}

function readSort(value: string | undefined): 'near' | 'together' | null {
  if (value === undefined || value === '') return null;
  if (value !== 'near' && value !== 'together') throw new BadRequestException('sort 는 near 또는 together 여야 합니다.');
  return value;
}

/** `mapx,mapy` — 좌표가 아니면 튕긴다. 잘못된 앵커로 반경을 잡으면 엉뚱한 곳이 나온다 */
function readAnchor(value: string | undefined): { mapx: number; mapy: number } | null {
  if (value === undefined || value === '') return null;
  const [x, y] = value.split(',').map((s) => Number(s.trim()));
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new BadRequestException('anchor 는 "경도,위도" 형식이어야 합니다.');
  }
  return { mapx: x, mapy: y };
}

function readPage(value: string | undefined): number {
  const n = value === undefined || value === '' ? 1 : Number(value);
  if (!Number.isInteger(n) || n < 1) throw new BadRequestException('page 는 1 이상 정수여야 합니다.');
  return n;
}
