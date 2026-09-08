import { BadRequestException, HttpStatus } from '@nestjs/common';
import type { PlaceNameResolver } from '../audit/place-name';
import type { CatalogService } from '../catalog/catalog.service';
import { DomainException } from '../common/domain.exception';
import type { PatchApplicationRepository } from '../persistence/patch-application.repository';
import {
  validateAddItem,
  validateCreate,
  validateOrder,
  validatePatchItem,
  validateUpdate,
  type CreateProductDto,
  type UpdateProductDto,
} from './product.dto';
import {
  ProductRepository,
  type CreatedProduct,
  type ItemDetail,
  type ProductDetailRow,
  type ProductListRow,
} from './product.repository';

/**
 * 상품 CRUD 오케스트레이션 (F01 · API 설계 5-1/5-2).
 *
 * 검증은 순수 함수(product.dto)가 하고, 여기서는 저장·조회를 엮고 지역 코드에 이름을 붙인다.
 * 지역명은 KTO 코드 조회로 얻는다 — fixture 리플레이라 예산을 쓰지 않는다.
 */
export class ProductService {
  constructor(
    private readonly repo: ProductRepository,
    private readonly catalog: CatalogService,
    private readonly patches: PatchApplicationRepository,
    private readonly placeNames: PlaceNameResolver,
  ) {}

  async create(accountId: number, dto: CreateProductDto): Promise<CreatedProduct> {
    const { errors, product } = validateCreate(dto);
    if (product === null) throw new BadRequestException(errors.join(' '));
    return this.repo.create(accountId, product);
  }

  async list(accountId: number, page: number, size: number): Promise<Record<string, unknown>> {
    const { rows, total } = await this.repo.list(accountId, page, size);
    const names = await this.regionNames(rows);
    return {
      content: rows.map((r) => ({
        productId: r.id,
        name: r.name,
        startDate: r.startDate,
        nights: r.nights,
        region: names.region(r.ldongRegnCd, r.ldongSignguCd),
        latestAudit: r.latestAudit,
        unreadNotifications: r.unreadNotifications,
        pendingMatches: r.pendingMatches,
      })),
      page,
      size,
      totalElements: total,
      totalPages: size > 0 ? Math.ceil(total / size) : 0,
    };
  }

  async detail(accountId: number, productId: number): Promise<Record<string, unknown>> {
    const row = await this.repo.detail(accountId, productId);
    if (row === null) throw notFound(productId);
    const names = await this.regionNames([row]);
    return {
      productId: row.id,
      name: row.name,
      region: names.region(row.ldongRegnCd, row.ldongSignguCd),
      ldongRegnCd: row.ldongRegnCd,
      ldongSignguCd: row.ldongSignguCd,
      startDate: row.startDate,
      nights: row.nights,
      dayCount: row.nights + 1,
      targetKey: row.targetKey,
      conceptKey: row.conceptKey,
      headCount: row.headCount,
      transport: row.transport,
      releasedAt: row.releasedAt,
      createdAt: row.createdAt,
      days: toDays(await this.withCurrentNames(productId, row.items)),
    };
  }

  /**
   * 패치로 콘텐츠가 바뀐 항목의 이름을 **응답에만** 채운다 (FR-PA-003 · DR-PR-001).
   *
   * 저장된 `place_label` 은 그대로다 — 대체 후보의 명칭은 공사 원문이라 저장할 수 없다.
   * 그래서 미리보기에서는 새 관광지로 보이다가 확정하면 옛 이름으로 돌아가 있었다.
   *
   * 조회는 대체·추가된 항목 수만큼이고, 패치한 적 없는 상품은 0콜이다. 실패는 지역명
   * 조회와 같이 삼킨다 — 이름은 부가 정보이고 일정 조회가 여기서 실패하면 안 된다.
   */
  private async withCurrentNames(
    productId: number,
    items: readonly ItemDetail[],
  ): Promise<readonly ItemDetail[]> {
    try {
      const stale = await this.patches.staleLabelItemIds(productId);
      if (stale.size === 0) return items;

      const wanted = items
        .filter((it) => stale.has(it.itemId) && it.ktoContentId !== null)
        .map((it) => it.ktoContentId as string);
      if (wanted.length === 0) return items;

      const names = await this.placeNames.resolve(wanted);
      return items.map((it) => {
        if (!stale.has(it.itemId) || it.ktoContentId === null) return it;
        const name = names.get(it.ktoContentId);
        // 못 읽으면 저장된 라벨을 둔다. 지어내지 않는다
        return name === undefined ? it : { ...it, place: name };
      });
    } catch {
      return items;
    }
  }

  async update(accountId: number, productId: number, dto: UpdateProductDto): Promise<{ productId: number; updated: true }> {
    const { errors, update } = validateUpdate(dto);
    if (errors.length > 0) throw new BadRequestException(errors.join(' '));
    const ok = await this.repo.updateBasic(accountId, productId, update);
    if (!ok) throw notFound(productId);
    return { productId, updated: true };
  }

  async remove(accountId: number, productId: number): Promise<void> {
    const ok = await this.repo.remove(accountId, productId);
    if (!ok) throw notFound(productId);
  }

  // ── 일정 항목 개별 CRUD (FR-IN-013/014) ──────────────────────────────────

  async addItem(accountId: number, productId: number, body: unknown): Promise<Record<string, unknown>> {
    const nights = await this.repo.ownedNights(accountId, productId);
    if (nights === null) throw notFound(productId);
    const { errors, item } = validateAddItem(body as Record<string, unknown> | undefined, nights + 1);
    if (item === undefined) throw new BadRequestException(errors.join(' '));
    return { ...(await this.repo.addItem(productId, item)) };
  }

  async patchItem(accountId: number, itemId: number, body: unknown): Promise<Record<string, unknown>> {
    const { errors, patch } = validatePatchItem(body as Record<string, unknown> | undefined);
    if (patch === undefined) throw new BadRequestException(errors.join(' '));
    const updated = await this.repo.patchItem(accountId, itemId, patch);
    if (updated === null) throw notFoundItem(itemId);
    return { ...updated };
  }

  async removeItem(accountId: number, itemId: number): Promise<void> {
    const ok = await this.repo.deleteItem(accountId, itemId);
    if (!ok) throw notFoundItem(itemId);
  }

  async reorderItems(accountId: number, productId: number, body: unknown): Promise<{ productId: number; reordered: number }> {
    const nights = await this.repo.ownedNights(accountId, productId);
    if (nights === null) throw notFound(productId);
    const { errors, order } = validateOrder(body as { items?: unknown } | undefined, nights + 1);
    if (order === undefined) throw new BadRequestException(errors.join(' '));
    const count = await this.repo.reorderItems(accountId, productId, order);
    // null 은 상품의 전체 항목을 빠짐없이 보내지 않았거나 남의 항목이 섞인 것이다
    if (count === null) throw new BadRequestException('상품의 모든 항목 순서를 빠짐없이 보내야 합니다.');
    return { productId, reordered: count };
  }

  /** 목록에 나온 지역 코드들을 한 번에 이름으로 바꾼다. 조회 실패는 삼키고 코드를 그대로 둔다 */
  private async regionNames(
    rows: readonly { ldongRegnCd: string; ldongSignguCd: string | null }[],
  ): Promise<{ region: (regn: string, signgu: string | null) => { regnName: string; signguName: string | null } }> {
    const regnNames = new Map<string, string>();
    const signguNames = new Map<string, string>();
    try {
      for (const item of await this.catalog.regions()) regnNames.set(item.code, item.name);
      const regnCodes = new Set(rows.map((r) => r.ldongRegnCd));
      for (const regn of regnCodes) {
        for (const item of await this.catalog.signgus(regn)) signguNames.set(`${regn}:${item.code}`, item.name);
      }
    } catch {
      // 코드→이름 조회는 부가 정보다. 실패해도 상품 목록은 코드로 뜬다
    }
    return {
      region: (regn, signgu) => ({
        regnName: regnNames.get(regn) ?? regn,
        signguName: signgu === null ? null : (signguNames.get(`${regn}:${signgu}`) ?? signgu),
      }),
    };
  }
}

function notFound(productId: number): DomainException {
  // 소유자가 아니면 조회 자체가 0건이라 여기로 온다 — 403 이 아니라 404 로 존재를 숨긴다 (EX-SY-003)
  return new DomainException(HttpStatus.NOT_FOUND, 'NOT_FOUND', `상품을 찾을 수 없습니다 (#${productId}).`, 'PRODUCT');
}

function notFoundItem(itemId: number): DomainException {
  // 남의 항목도 없는 항목과 똑같이 404 다 (item -> product -> account 스코프에서 0건)
  return new DomainException(HttpStatus.NOT_FOUND, 'NOT_FOUND', `일정 항목을 찾을 수 없습니다 (#${itemId}).`, 'REQUEST');
}

/** 항목을 일차별로 묶는다 (화면·편집이 일차 단위로 다룬다) */
function toDays(items: ProductDetailRow['items']): { day: number; items: unknown[] }[] {
  const byDay = new Map<number, unknown[]>();
  for (const it of items) {
    const list = byDay.get(it.dayNo) ?? [];
    list.push({
      itemId: it.itemId,
      seq: it.seq,
      start: it.start,
      end: it.end,
      place: it.place,
      itemType: it.itemType,
      ktoContentId: it.ktoContentId,
      matchStatus: it.matchStatus,
    });
    byDay.set(it.dayNo, list);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, dayItems]) => ({ day, items: dayItems }));
}

export type ProductListView = ProductListRow;
