import { HttpStatus } from '@nestjs/common';
import type { KtoClient } from '../external/kto';
import { DomainException } from '../common/domain.exception';
import { PlaceMatchRepository, type ItemForMatch } from './place-match.repository';

/**
 * 관광지 확정(매칭) 오케스트레이션 (F02 · API 설계 5-3).
 *
 * 검색은 공사 `searchKeyword2` 프록시, 확정은 `detailCommon2` 로 좌표·분류를 취득해 저장한다.
 * 저장은 코드·좌표뿐 — 명칭·운영시간 원문은 담지 않는다 (DR-PR-001). 응답의 명칭·주소는
 * 확정 시점 실시간 취득값이라 표시에만 쓴다.
 */

export interface SearchParams {
  readonly keyword: string;
  readonly regnCd?: string;
  readonly signguCd?: string;
  readonly page?: number;
  readonly size?: number;
}

export class PlaceMatchService {
  private readonly repo: PlaceMatchRepository;

  constructor(
    repo: PlaceMatchRepository,
    private readonly kto: () => KtoClient,
  ) {
    this.repo = repo;
  }

  /** 장소명으로 공사 콘텐츠를 검색한다. 지역 코드를 주면 그 시도·시군구로 좁힌다 (FR-IN-022) */
  async search(params: SearchParams): Promise<Record<string, unknown>> {
    const keyword = params.keyword.trim();
    if (keyword === '') {
      throw new DomainException(HttpStatus.BAD_REQUEST, 'NOT_FOUND', '검색어를 입력해 주세요.', 'REQUEST');
    }
    const page = await this.kto().searchKeyword({
      keyword,
      lDongRegnCd: params.regnCd,
      lDongSignguCd: params.signguCd,
      numOfRows: clamp(params.size ?? 20, 20),
      pageNo: (params.page ?? 0) + 1,
    });
    return {
      regionFilterApplied: Boolean(params.regnCd),
      fetchedAt: new Date().toISOString(),
      candidates: page.items.map(toCandidate),
      totalCount: page.totalCount ?? page.items.length,
      source: '출처: ⓒ한국관광공사',
    };
  }

  /**
   * 항목에 contentid 를 확정한다. 확정 시점에 상세를 조회해 좌표·분류를 저장하고, 표시용 원문을
   * 응답으로 돌려준다 (실시간 취득 · FR-IN-025).
   */
  async match(accountId: number, itemId: number, contentId: string): Promise<Record<string, unknown>> {
    const item = await this.requireItem(accountId, itemId);
    if (contentId.trim() === '') {
      throw new DomainException(HttpStatus.BAD_REQUEST, 'NOT_FOUND', 'contentid 가 필요합니다.', 'ITEM');
    }
    const common = await this.kto().detailCommon(contentId);
    const contentTypeId = int(common.contenttypeid);
    if (contentTypeId === null) {
      throw new DomainException(HttpStatus.BAD_REQUEST, 'CONTENT_NOT_FOUND', '선택한 관광지 정보를 가져오지 못했습니다.', 'ITEM');
    }
    const mapx = num(common.mapx);
    const mapy = num(common.mapy);
    const lclsSystm1 = str(common.lclsSystm1);
    const lclsSystm2 = str(common.lclsSystm2);
    const lclsSystm3 = str(common.lclsSystm3);

    await this.repo.confirm(item.itemId, { contentId, contentTypeId, lclsSystm1, lclsSystm2, lclsSystm3, mapx, mapy });

    return {
      itemId: item.itemId,
      matchStatus: 'CONFIRMED',
      content: {
        contentid: contentId,
        title: str(common.title),
        addr1: str(common.addr1),
        contenttypeid: contentTypeId,
        lclsSystm1,
        lclsSystm2,
        lclsSystm3,
        mapx,
        mapy,
        cpyrhtDivCd: str(common.cpyrhtDivCd),
      },
      fetchedAt: new Date().toISOString(),
      // 실측상 대부분 Type3(변경금지)라 기본값으로 가정하고 병기한다 (FR-CM-011)
      sourceBadge: { type: 'KTO_RAW', note: '변경금지' },
    };
  }

  /** 해당 없음 — 검수 대상에서 제외한다 (FR-IN-021) */
  async exclude(accountId: number, itemId: number): Promise<Record<string, unknown>> {
    const item = await this.requireItem(accountId, itemId);
    await this.repo.exclude(item.itemId);
    return { itemId: item.itemId, matchStatus: 'EXCLUDED' };
  }

  private async requireItem(accountId: number, itemId: number): Promise<ItemForMatch> {
    const item = await this.repo.findItem(accountId, itemId);
    if (item === null) {
      // 소유자가 아니면 조회가 0건이라 여기로 온다 — 존재를 숨긴다 (EX-SY-003)
      throw new DomainException(HttpStatus.NOT_FOUND, 'NOT_FOUND', `항목을 찾을 수 없습니다 (#${itemId}).`, 'ITEM');
    }
    return item;
  }
}

function toCandidate(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    contentid: str(raw.contentid),
    title: str(raw.title),
    addr1: str(raw.addr1),
    contenttypeid: int(raw.contenttypeid),
    lDongRegnCd: str(raw.lDongRegnCd),
    lDongSignguCd: str(raw.lDongSignguCd),
    cpyrhtDivCd: str(raw.cpyrhtDivCd),
  };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}

function clamp(size: number, fallback: number): number {
  if (!Number.isFinite(size) || size <= 0) return fallback;
  return Math.min(Math.floor(size), 50);
}
