import { BadRequestException, HttpStatus } from '@nestjs/common';
import { DWELL_MINUTES_SEED, SETTING_DEFAULTS } from '@tourlint/shared';
import type { AuditService } from '../audit/audit.service';
import type { PlaceNameResolver } from '../audit/place-name';
import type { CatalogService } from '../catalog/catalog.service';
import type { KakaoMobilityClient } from '../external/kakao';
import { coordinateOf, estimateTravelMinutes } from '../plan/travel-estimate';
import type { WalkNameResolver } from '../plan/walk-names';
import { DomainException } from '../common/domain.exception';
import type { PatchApplicationRepository } from '../persistence/patch-application.repository';
import {
  validateAddItem,
  validateCreate,
  validateOrder,
  validatePatchItem,
  validatePickedItem,
  validateUpdate,
  validateWalkItem,
  type CreateProductDto,
  type PickedItemInput,
  type UpdateProductDto,
} from './product.dto';
import {
  addMinutes,
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
    private readonly audit: AuditService,
    private readonly walkNames: WalkNameResolver,
    // 장소 담기 시각을 앞 항목과의 이동시간으로 채운다 (FR-PL-013 · 4-3). 없으면 이동시간 없이 붙인다
    private readonly kakao: () => KakaoMobilityClient | null,
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
        activeNotifications: r.activeNotifications,
        risksSinceAudit: r.risksSinceAudit,
        pendingMatches: r.pendingMatches,
        plannedAt: r.plannedAt,
        releasedAt: r.releasedAt,
        startedBy: r.startedBy,
      })),
      page,
      size,
      totalElements: total,
      totalPages: size > 0 ? Math.ceil(total / size) : 0,
    };
  }

  /**
   * 출시 승인 (PM-NG-002 · EX-AU-008 · DR-IN-007).
   *
   * **화면 버튼을 비활성화하는 것만으로는 충족하지 않는다.** API 를 직접 불러도 막혀야 한다.
   * DB 트리거(`trg_check_release`)가 마지막으로 한 번 더 막지만, 거기까지 가면 사용자가
   * 읽을 수 없는 오류를 본다. 같은 판단을 여기서 먼저 해서 사유를 말해 준다.
   */
  async release(accountId: number, productId: number): Promise<{ productId: number; releasedAt: string | null }> {
    const basis = await this.repo.releaseBasis(accountId, productId);
    if (basis === undefined) throw notFound(productId);

    /*
     * **지금 일정의 검수 결과로 판정한다** (#551). 가장 최근 실행만 보면, 차단을 없앤 수정안을
     * 되돌려 차단이 있는 일정으로 돌아가도 반영 후 실행(차단 0)을 보고 통과시켰다.
     */
    const { current, currentBlockers, latestBlockers, itemCount } = basis;
    /*
     * **빈 일정은 출시하지 않는다** (#738). 검수 뒤 편집은 남은 항목의 시각으로 알아채는데(#710),
     * 항목을 전부 지우면 견줄 행이 없어 「바뀌지 않음」 이 되고 예전 검수(차단 0)로 통과했다.
     */
    if (itemCount === 0) {
      throw forbidden('일정이 비어 있습니다. 장소를 담고 검수한 뒤 출시해 주세요.');
    }
    if (current.kind === 'NONE') {
      throw forbidden('검수하지 않은 상품은 출시할 수 없습니다. 먼저 검수를 실행해 주세요.');
    }
    if (current.kind === 'STALE') {
      // 검수한 그 일정이 아니다. 고친 뒤의 일정에 차단이 있는지는 다시 검수해야 안다 (#710 · PM-NG-002)
      throw forbidden(current.reason === 'EDIT'
        ? '검수한 뒤에 일정이 바뀌었습니다. 다시 검수한 뒤 출시해 주세요.'
        : '수정안을 반영한 일정의 재검수가 아직 끝나지 않았습니다. 재검수 결과를 확인한 뒤 출시해 주세요.');
    }
    if ((currentBlockers ?? 0) > 0) {
      throw forbidden(`차단 ${String(currentBlockers)}건을 해결해야 출시할 수 있습니다.`);
    }
    // 되돌린 일정은 반영 전 실행으로 판정하지만 트리거는 가장 최근 실행을 본다. 거기서 읽을 수 없는 오류가 나기 전에 막는다
    if ((latestBlockers ?? 0) > 0) {
      throw forbidden('수정안을 되돌린 일정은 다시 검수한 뒤 출시할 수 있습니다.');
    }

    const releasedAt = await this.repo.markReleased(accountId, productId);
    if (releasedAt === null) throw notFound(productId);
    return { productId, releasedAt };
  }

  /** 일정 항목 목록 (FR-IN-009). 일차 · 순번 정렬은 저장소가 한다 */
  async items(accountId: number, productId: number): Promise<Record<string, unknown>> {
    const row = await this.repo.detail(accountId, productId);
    if (row === null) throw notFound(productId);
    return { totalCount: row.items.length, items: row.items };
  }

  async detail(accountId: number, productId: number): Promise<Record<string, unknown>> {
    const row = await this.repo.detail(accountId, productId);
    if (row === null) throw notFound(productId);
    const current = await this.repo.currentRun(productId);
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
      plannedAt: row.plannedAt,
      planOrigin: row.planOrigin,
      composition: row.composition,
      /*
       * 지금 일정과 검수 결과의 관계 (#710). `STALE` + `EDIT` 이면 화면의 결과는 고치기 전 일정의 것이다 —
       * 화면이 브라우저 기억으로만 알던 것을 서버가 말해 준다. 새로 고쳐도, 편집 화면을 다녀와도 같다.
       */
      auditState: current === null
        ? { kind: 'NONE', reason: null }
        : { kind: current.kind, reason: current.kind === 'STALE' ? current.reason : null },
      createdAt: row.createdAt,
      days: toDays(await this.withDisplayNames(await this.withCurrentNames(productId, row.items))),
    };
  }

  /**
   * 검수 시작 (handoff · FR-PL-020 · D7). 기획 중 상품을 검수 중으로 넘긴다.
   *
   * 미확정이 남았는데 `excludePending` 이 아니면 422 로 건수를 알려 준다. `excludePending` 이면
   * 남은 미확정을 검수 제외로 바꾸고 `planned_at` 을 찍은 뒤 검수를 요청한다. 검수 요청이
   * 거절되면(예산 100% 429 등) 방금 바꾼 것을 되돌려 상품을 기획 중에 남긴다 — 반쯤 바뀐
   * 상품을 만들지 않는다.
   */
  async handoff(
    accountId: number,
    productId: number,
    excludePending: boolean,
  ): Promise<{ productId: number; plannedAt: string; jobId: number; excludedCount: number }> {
    const state = await this.repo.handoffState(accountId, productId);
    if (state === null) throw notFound(productId);

    // 검수 시작 관문 — 박수↔일정 완성도를 여기서 본다 (EX-IN-005 개정: 저장이 아니라 검수 시작이 검사).
    // 기획 중에는 빈 일차를 허용하지만, 검수는 모든 일차에 일정이 있어야 시작한다.
    const missingDays = Array.from({ length: state.nights + 1 }, (_, i) => i + 1)
      .filter((d) => !state.daysWithItems.includes(d));
    if (missingDays.length > 0) {
      throw new DomainException(
        HttpStatus.UNPROCESSABLE_ENTITY, 'DAY_COUNT_MISMATCH',
        `아직 일정이 없는 일차가 있습니다 (${missingDays.join(' · ')}일차). 모든 일차에 일정을 넣어야 검수를 시작할 수 있습니다.`,
        'PRODUCT',
        [{ field: 'missingDays', message: missingDays.join(',') }],
      );
    }

    if (state.pendingIds.length > 0 && !excludePending) {
      throw new DomainException(
        HttpStatus.UNPROCESSABLE_ENTITY, 'PLACE_UNRESOLVED',
        `아직 고르지 않은 장소가 ${state.pendingIds.length}곳 있습니다. 장소를 고르거나 이대로 검수 시작을 눌러 주세요.`,
        'PRODUCT',
        [{ field: 'pendingCount', message: String(state.pendingIds.length) }],
      );
    }

    const excludeIds = excludePending ? state.pendingIds : [];
    const wasPlanned = state.plannedAt !== null;
    const plannedAt = await this.repo.applyHandoff(productId, excludeIds);
    try {
      // 첫 검수다 — 다시 검수(MANUAL)와 가른다 (FR-AU-026 ①)
      const { job } = await this.audit.requestAudit(productId, 'INITIAL');
      return { productId, plannedAt, jobId: job.id, excludedCount: excludeIds.length };
    } catch (err) {
      // 검수 요청이 거절됐다 — 방금 넘긴 것을 되돌려 기획 중에 남긴다
      await this.repo.revertHandoff(productId, excludeIds, !wasPlanned);
      throw err;
    }
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

  /**
   * 저장된 라벨이 빈 항목의 표시 이름을 볼 때 채운다 (D1 · D9).
   *
   * 장소 담기(CONFIRMED)와 걷기 길(EXCLUDED)은 이름을 저장하지 않는다 — `place_label` 이
   * 비어 있다. 콘텐츠면 공식 명칭을, 걷기 길이면 코스 이름을 찾아 얹고, **못 찾으면 걷기 길은
   * "걷기 길" 로 두고 콘텐츠는 빈 채로 둔다**(지어내지 않는다). 조회 실패는 삼킨다.
   */
  private async withDisplayNames(items: readonly ItemDetail[]): Promise<readonly ItemDetail[]> {
    const emptyContent = items
      .filter((it) => it.place === '' && it.walkId === null && it.ktoContentId !== null)
      .map((it) => it.ktoContentId as string);
    const emptyWalk = items
      .filter((it) => it.place === '' && it.walkId !== null)
      .map((it) => it.walkId as string);
    if (emptyContent.length === 0 && emptyWalk.length === 0) return items;

    let contentNames: ReadonlyMap<string, string> = new Map();
    let walkNames: ReadonlyMap<string, string> = new Map();
    try {
      [contentNames, walkNames] = await Promise.all([
        emptyContent.length > 0 ? this.placeNames.resolve(emptyContent) : Promise.resolve(new Map()),
        emptyWalk.length > 0 ? this.walkNames.resolve(emptyWalk) : Promise.resolve(new Map()),
      ]);
    } catch {
      // 못 읽어도 걷기 길은 아래에서 "걷기 길" 로 채운다. 콘텐츠는 빈 채로 둔다
    }

    return items.map((it) => {
      if (it.place !== '') return it;
      if (it.walkId !== null) return { ...it, place: walkNames.get(it.walkId) ?? '걷기 길' };
      if (it.ktoContentId !== null) {
        const name = contentNames.get(it.ktoContentId);
        return name === undefined ? it : { ...it, place: name };
      }
      return it;
    });
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
    const b = body as Record<string, unknown> | undefined;
    // 걷기 길로 넣으면 excluded.walkId 가 온다 — 직접 정한 곳(EXCLUDED)으로 넣고 이름은 저장 안 함 (D9)
    if (b !== undefined && typeof b.excluded === 'object' && b.excluded !== null) {
      const { errors, walk } = validateWalkItem(b, nights + 1);
      if (walk === undefined) throw new BadRequestException(errors.join(' '));
      return { ...(await this.repo.addWalkItem(productId, walk)) };
    }
    // 장소 담기로 넣으면 content 가 온다 — 이미 고른 콘텐츠라 CONFIRMED 로 넣는다 (FR-PL-013 · 4-3)
    if (b !== undefined && typeof b.content === 'object' && b.content !== null) {
      const { errors, picked } = validatePickedItem(b, nights + 1);
      if (picked === undefined) throw new BadRequestException(errors.join(' '));
      return { ...(await this.insertPicked(productId, picked)) };
    }
    const { errors, item } = validateAddItem(b, nights + 1);
    if (item === undefined) throw new BadRequestException(errors.join(' '));
    return { ...(await this.repo.addItem(productId, item)) };
  }

  /**
   * 장소 담기 삽입 (FR-PL-013 · 4-3). 넣을 위치(`afterItemId`) 다음에 끼우고, 시작 시각은
   * **앞 항목 끝 + 이동시간**으로 채운다.
   *
   * 이동시간은 카카오 길찾기로 잰다 — **못 재면(좌표 없음 · 대중교통 · 조회 실패) 이동시간을
   * 짓지 않고** 앞 항목 끝에 바로 붙인다(FR-RU-051 · R08 과 같은 원칙). 끝 시각은 표준
   * 체류시간으로 채운다(숙박은 끝 시각 없음).
   */
  private async insertPicked(productId: number, picked: PickedItemInput): Promise<ItemDetail> {
    const { transport, anchor } = await this.repo.pickPlacement(productId, picked.dayNo, picked.afterItemId);

    let start = '09:00';
    if (anchor !== null) {
      const travel = await estimateTravelMinutes({
        kakao: this.kakao(),
        from: coordinateOf(anchor.mapx, anchor.mapy),
        to: coordinateOf(picked.content.mapx, picked.content.mapy),
        transport,
      });
      start = addMinutes(anchor.availableFrom, travel ?? 0);
    }

    const dwell = picked.itemType === 'LODGING' ? null
      : (picked.content.lcls2 !== null ? DWELL_MINUTES_SEED[picked.content.lcls2] : undefined) ?? SETTING_DEFAULTS.dwellFallbackMinutes;
    const end = dwell === null ? null : addMinutes(start, dwell);

    return this.repo.insertPickedItem(productId, picked, { start, end, afterSeq: anchor?.seq ?? null });
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

/** 출시 승인 거절. 화면이 그대로 보여 준다 (PM-NG-002 · EX-AU-008) */
function forbidden(message: string): DomainException {
  return new DomainException(HttpStatus.FORBIDDEN, 'FORBIDDEN_ACTION', message, 'REQUEST');
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
      mapx: it.mapx,
      mapy: it.mapy,
      // 끝 시간 미리보기 · 「기본값 적용」 표시용 (FR-IN-011 · UI-S2-009). 판정에는 쓰지 않는다
      lcls2: it.lcls2,
      endTimeSource: it.endTimeSource,
    });
    byDay.set(it.dayNo, list);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, dayItems]) => ({ day, items: dayItems }));
}

export type ProductListView = ProductListRow;
