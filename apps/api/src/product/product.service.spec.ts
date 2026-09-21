import { resolve } from 'node:path';
import { HttpStatus } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainException } from '../common/domain.exception';
import { PlaceNameResolver } from '../audit/place-name';
import { CatalogService } from '../catalog/catalog.service';
import { InMemoryApiCallLogger } from '../external/api-call-log';
import { FixtureKtoTransport, KtoClient } from '../external/kto';
import { PatchApplicationRepository } from '../persistence/patch-application.repository';
import { WalkNameResolver } from '../plan/walk-names';
import { validateCreate } from './product.dto';
import { ProductRepository } from './product.repository';
import { ProductService } from './product.service';

/**
 * 대체·추가된 항목의 표시 이름 — 실 DB. 패치 이력(jsonb 스냅샷)을 읽어야 하는 판단이라
 * 가짜 커넥션으로는 검증되지 않는다.
 */

const URL = process.env.TEST_DATABASE_URL;
const FIXTURE_DIR = resolve(process.cwd(), '../../fixtures/kto');
const EMAIL = 'zz-product-name-spec@tourlint.test';

/** 픽스처에 detailCommon2 스냅샷이 있는 콘텐츠 */
const ORIGINAL = '125790';           // 강릉 경포대
const REPLACEMENT = '129784';        // 강릉 오죽헌·시립박물관

describe.skipIf(URL === undefined)('ProductService — 대체된 항목의 이름 (FR-PA-003)', () => {
  let pool: Pool;
  let service: ProductService;
  let patches: PatchApplicationRepository;
  let accountId: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 4 });
    patches = new PatchApplicationRepository(pool);
    const kto = (): KtoClient =>
      new KtoClient({ transport: new FixtureKtoTransport(FIXTURE_DIR), logger: new InMemoryApiCallLogger() });
    service = new ProductService(
      new ProductRepository(pool),
      new CatalogService(kto),
      patches,
      new PlaceNameResolver({ kto }),
      {} as never, // 이 스펙은 handoff 를 부르지 않는다
      new WalkNameResolver({ kto, budget: async () => ({ allowed: true, ratio: 0, reasonCode: null, warn: false, remaining: 800 }) }),
      () => null, // 이 스펙은 카카오 이동시간 없이 앞 항목 끝에 붙는 경로를 본다
    );
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO account (email, password_hash) VALUES ($1, 'x')
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
      [EMAIL],
    );
    accountId = Number(rows[0]?.id);
  });

  afterAll(async () => {
    // 상품을 먼저 지운다 — patch_application.applied_by 는 계정을 CASCADE 하지 않는다
    await pool.query(`DELETE FROM product WHERE account_id = $1`, [accountId]);
    await pool.query(`DELETE FROM account WHERE email = $1`, [EMAIL]);
    await pool.end();
  });

  async function makeProduct(): Promise<{ productId: number; itemId: number }> {
    const { product } = validateCreate({
      name: '이름 덮어쓰기 스펙 당일',
      ldongRegnCd: '51', ldongSignguCd: '150', startDate: '2026-10-22', nights: 0, transport: 'CAR',
      days: [{ day: 1, items: [{ start: '10:00', end: '11:30', place: '경포대', itemType: 'SIGHT' }] }],
    });
    if (product === null) throw new Error('샘플 검증 실패');
    const created = await new ProductRepository(pool).create(accountId, product);
    const { rows } = await pool.query<{ id: string }>(
      `UPDATE itinerary_item SET kto_content_id = $2, match_status = 'CONFIRMED'
        WHERE product_id = $1 RETURNING id`,
      [created.productId, ORIGINAL],
    );
    return { productId: created.productId, itemId: Number(rows[0]?.id) };
  }

  /** 대체를 확정한 것과 같은 상태를 만든다 — 항목의 콘텐츠는 바뀌고 라벨은 그대로다 */
  async function applyReplacement(productId: number, itemId: number, reverted = false): Promise<void> {
    const item = (contentId: string) => ({
      id: itemId, dayNo: 1, seq: 1, startTime: '10:00', endTime: '11:30', endTimeSource: 'INPUT',
      placeLabel: '경포대', itemType: 'SIGHT', ktoContentId: contentId, contentTypeId: 12,
      lclsSystm1: null, lclsSystm2: null, lclsSystm3: null, mapx: null, mapy: null, matchStatus: 'CONFIRMED',
    });
    await pool.query(
      `INSERT INTO patch_application
         (product_id, applied_at, applied_by, selected_patches, before_snapshot, after_snapshot, reverted_at)
       VALUES ($1, now(), $2, $6::jsonb, $3, $4, $5)`,
      [productId, accountId,
        JSON.stringify({ version: '1.0', items: [item(ORIGINAL)] }),
        JSON.stringify({ version: '1.0', items: [item(REPLACEMENT)] }),
        reverted ? new Date() : null,
        // 최소 1건이어야 한다 (ck_patch_selected). 이 테스트는 선택 내용을 보지 않는다
        JSON.stringify([{ findingId: 1, patchId: 'p-1' }])],
    );
    await pool.query(`UPDATE itinerary_item SET kto_content_id = $2 WHERE id = $1`, [itemId, REPLACEMENT]);
  }

  const placeOf = (detail: Record<string, unknown>): unknown =>
    ((detail.days as { items: { place: unknown }[] }[])[0]?.items[0])?.place;

  it('대체하면 저장된 라벨 대신 지금 콘텐츠의 이름을 준다', async () => {
    const { productId, itemId } = await makeProduct();
    await applyReplacement(productId, itemId);

    expect(placeOf(await service.detail(accountId, productId))).toBe('강릉 오죽헌·시립박물관');

    const { rows } = await pool.query<{ place_label: string }>(
      `SELECT place_label FROM itinerary_item WHERE id = $1`, [itemId],
    );
    // 저장은 그대로다 — 공사 원문을 넣지 않는다 (DR-PR-001)
    expect(rows[0]?.place_label).toBe('경포대');
  });

  it('되돌린 패치는 세지 않는다 — 콘텐츠가 원래대로 돌아오므로 라벨이 다시 맞는다', async () => {
    const { productId, itemId } = await makeProduct();
    await applyReplacement(productId, itemId, true);
    await pool.query(`UPDATE itinerary_item SET kto_content_id = $2 WHERE id = $1`, [itemId, ORIGINAL]);

    expect(placeOf(await service.detail(accountId, productId))).toBe('경포대');
  });

  it('패치한 적 없는 상품은 저장된 라벨 그대로다 — 조회하지 않는다', async () => {
    const { productId } = await makeProduct();
    expect(placeOf(await service.detail(accountId, productId))).toBe('경포대');
    expect(await patches.staleLabelItemIds(productId)).toEqual(new Set());
  });

  const picked = (contentId: string) => ({
    dayNo: 1, itemType: 'MEAL', origin: 'PICKER',
    content: { contentId, contentTypeId: 39, lcls1: null, lcls2: null, lcls3: null, mapx: null, mapy: null },
  });

  it('🔴 넣을 위치(afterItemId) 다음에 끼우고 뒤 항목 순번을 민다 (4-3)', async () => {
    const { productId, itemId } = await makeProduct();
    // 그 날 끝에 하나 더 붙여 [경포대(seq1), 뒤(seq2)] 를 만든다
    await service.addItem(accountId, productId, picked(REPLACEMENT));
    const before = (await service.detail(accountId, productId)).days as { items: { itemId: number; seq: number }[] }[];
    const tailId = before[0]?.items[1]?.itemId;

    // 첫 항목(경포대) 다음에 끼운다 — 뒤 항목은 한 칸 밀려야 한다
    await service.addItem(accountId, productId, { ...picked(ORIGINAL), afterItemId: itemId });

    const rows = (await pool.query<{ id: string; seq: number }>(
      `SELECT id, seq FROM itinerary_item WHERE product_id = $1 ORDER BY seq`, [productId],
    )).rows;
    expect(rows.map((r) => Number(r.seq))).toEqual([1, 2, 3]);
    expect(Number(rows[0]?.id)).toBe(itemId);       // 앵커는 그대로 1번
    expect(Number(rows[2]?.id)).toBe(tailId);       // 밀린 항목이 3번
  });

  it('넣을 위치를 안 주면 그 날 끝에 붙는다', async () => {
    const { productId } = await makeProduct();
    await service.addItem(accountId, productId, picked(REPLACEMENT));
    const days = (await service.detail(accountId, productId)).days as { items: { seq: number }[] }[];
    expect(days[0]?.items.map((i) => i.seq)).toEqual([1, 2]);
  });
});

/**
 * 출시 승인의 거부 조건 (PM-NG-002 · EX-AU-008).
 *
 * DB 트리거가 마지막으로 막지만 그건 읽을 수 없는 오류다. 서버가 먼저 같은 판단을
 * 해서 사유를 말하는지를 여기서 본다 — 저장소는 스텁이라 DB 없이 돈다.
 */
describe('출시 승인 거부 (PM-NG-002)', () => {
  type Basis = Awaited<ReturnType<ProductRepository['releaseBasis']>>;
  const svc = (basis: Basis, released = '2026-09-09T00:00:00.000Z') =>
    new ProductService(
      {
        releaseBasis: async () => basis,
        markReleased: async () => released,
      } as unknown as ProductRepository,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      () => null,
    );
  /** 가장 최근 실행이 곧 지금 일정의 실행인 보통의 경우 */
  const latest = (blockers: number): Basis => ({
    current: { kind: 'LATEST', runId: 9, latestRunId: 9 }, currentBlockers: blockers, latestBlockers: blockers, itemCount: 3,
  });

  it('🔴 일정이 비어 있으면 가장 최근 검수가 차단 0 이어도 거부한다 (#738)', async () => {
    /*
     * 검수(차단 0) 뒤 항목을 전부 지우면 남은 행이 없어 편집으로 안 잡힌다(#710 의 구멍).
     * 예전 검수 결과로 빈 일정이 출시됐다.
     */
    const emptied: Basis = { current: { kind: 'LATEST', runId: 9, latestRunId: 9 }, currentBlockers: 0, latestBlockers: 0, itemCount: 0 };
    await expect(svc(emptied).release(1, 1)).rejects.toMatchObject({
      reasonCode: 'FORBIDDEN_ACTION',
      status: 403,
      message: '일정이 비어 있습니다. 장소를 담고 검수한 뒤 출시해 주세요.',
    });
  });

  it('🔴 차단이 1건이면 403 FORBIDDEN_ACTION 이다 — 화면 버튼만으로 충족하지 않는다', async () => {
    await expect(svc(latest(1)).release(1, 1)).rejects.toMatchObject({
      reasonCode: 'FORBIDDEN_ACTION',
      status: 403,
    });
  });

  it('🔴 되돌린 일정에 차단이 있으면 반영 후 실행이 0건이어도 거부한다 (#551)', async () => {
    /*
     * 2026-09-11 감사 치명 1번. 차단을 없앤 수정안을 확정 · 재검수(차단 0)한 뒤 되돌리면 일정은
     * 차단이 있는 반영 전으로 돌아가는데, 가장 최근 실행만 보던 승인은 통과시켰다.
     */
    const reverted: Basis = {
      current: { kind: 'RESTORED', runId: 8, latestRunId: 9 }, currentBlockers: 1, latestBlockers: 0, itemCount: 3,
    };
    await expect(svc(reverted).release(1, 1)).rejects.toMatchObject({
      reasonCode: 'FORBIDDEN_ACTION',
      message: '차단 1건을 해결해야 출시할 수 있습니다.',
    });
  });

  it('🔴 수정안을 반영하고 재검수 전이면 거부한다 — 판정한 실행이 없다', async () => {
    const stale: Basis = {
      current: { kind: 'STALE', runId: null, latestRunId: 9, reason: 'PATCH' }, currentBlockers: null, latestBlockers: 0, itemCount: 3,
    };
    await expect(svc(stale).release(1, 1)).rejects.toMatchObject({ reasonCode: 'FORBIDDEN_ACTION' });
  });

  it('🔴 검수한 뒤에 일정을 고쳤으면 거부하고 까닭을 말한다 — 가장 최근 실행이 차단 0 이어도 (#710)', async () => {
    /*
     * 2026-09-21 운영. 검수 100점 → 식사를 03:00 으로 옮김 → 출시 승인 200. 다시 검수하니 차단 1.
     * 가장 최근 실행은 고치기 전 일정의 것이라 차단 0 이다 — 그 숫자로 판정하면 안 된다.
     */
    const edited: Basis = {
      current: { kind: 'STALE', runId: null, latestRunId: 9, reason: 'EDIT' }, currentBlockers: null, latestBlockers: 0, itemCount: 3,
    };
    await expect(svc(edited).release(1, 1)).rejects.toMatchObject({
      reasonCode: 'FORBIDDEN_ACTION',
      message: '검수한 뒤에 일정이 바뀌었습니다. 다시 검수한 뒤 출시해 주세요.',
    });
  });

  it('되돌린 일정이 깨끗해도 가장 최근 실행에 차단이 있으면 다시 검수하게 한다 — 트리거보다 먼저 사유를 말한다', async () => {
    const reverted: Basis = {
      current: { kind: 'RESTORED', runId: 8, latestRunId: 9 }, currentBlockers: 0, latestBlockers: 2, itemCount: 3,
    };
    await expect(svc(reverted).release(1, 1)).rejects.toMatchObject({
      reasonCode: 'FORBIDDEN_ACTION',
      message: '수정안을 되돌린 일정은 다시 검수한 뒤 출시할 수 있습니다.',
    });
  });

  it('검수한 적 없는 상품도 거부한다', async () => {
    const none: Basis = { current: { kind: 'NONE', runId: null, latestRunId: null }, currentBlockers: null, latestBlockers: null, itemCount: 3 };
    await expect(svc(none).release(1, 1)).rejects.toMatchObject({ reasonCode: 'FORBIDDEN_ACTION' });
  });

  it('남의 상품은 404 로 존재를 숨긴다 (EX-SY-003)', async () => {
    await expect(svc(undefined).release(1, 1)).rejects.toMatchObject({ reasonCode: 'NOT_FOUND' });
  });

  it('차단 0건이면 승인 시각을 돌려준다', async () => {
    await expect(svc(latest(0)).release(1, 7)).resolves.toEqual({
      productId: 7,
      releasedAt: '2026-09-09T00:00:00.000Z',
    });
  });

  it('되돌린 일정도 차단이 없으면 승인한다 — 반영 전 실행이 지금 결과다', async () => {
    const reverted: Basis = {
      current: { kind: 'RESTORED', runId: 8, latestRunId: 9 }, currentBlockers: 0, latestBlockers: 0, itemCount: 3,
    };
    await expect(svc(reverted).release(1, 7)).resolves.toMatchObject({ productId: 7 });
  });
});

describe('검수 시작 handoff (FR-PL-020 · D7) — 저장소 · 검수는 스텁', () => {
  interface Calls {
    applied?: readonly number[];
    reverted?: { ids: readonly number[]; clearPlanned: boolean };
    requested: boolean;
  }

  // 미확정 pendingIds 와 검수 요청 성공 여부를 주면, 그 조합으로 handoff 를 돌린다.
  function make(opts: { pendingIds: number[]; plannedAt: string | null; budgetOk: boolean; nights?: number; daysWithItems?: number[] }) {
    const calls: Calls = { requested: false };
    const nights = opts.nights ?? 2;
    // 기본은 모든 일차가 채워진 완성 일정 — 완성도 가드를 통과시킨다
    const daysWithItems = opts.daysWithItems ?? Array.from({ length: nights + 1 }, (_, i) => i + 1);
    const repo = {
      handoffState: async () => ({ plannedAt: opts.plannedAt, pendingIds: opts.pendingIds, nights, daysWithItems }),
      applyHandoff: async (_productId: number, ids: readonly number[]) => {
        calls.applied = ids;
        return '2026-10-01T00:00:00.000Z';
      },
      revertHandoff: async (_productId: number, ids: readonly number[], clearPlanned: boolean) => {
        calls.reverted = { ids, clearPlanned };
      },
    } as unknown as ProductRepository;
    const audit = {
      requestAudit: async () => {
        calls.requested = true;
        if (!opts.budgetOk) {
          throw new DomainException(HttpStatus.TOO_MANY_REQUESTS, 'BUDGET_EXHAUSTED', '예산 소진', 'REQUEST');
        }
        return { job: { id: 42 }, created: true };
      },
    } as unknown as import('../audit/audit.service').AuditService;
    const svc = new ProductService(repo, {} as never, {} as never, {} as never, audit, {} as never, () => null);
    return { svc, calls };
  }

  it('🔴 빈 일차가 있으면 검수 시작을 막는다 (EX-IN-005 개정 — 검수 시작 관문)', async () => {
    // 2박 3일인데 2일차에 일정이 없다 — 검수 시작 거부
    const { svc, calls } = make({ pendingIds: [], plannedAt: null, budgetOk: true, nights: 2, daysWithItems: [1, 3] });
    await expect(svc.handoff(1, 9, true)).rejects.toMatchObject({
      reasonCode: 'DAY_COUNT_MISMATCH',
      status: 422,
      fieldErrors: [{ field: 'missingDays', message: '2' }],
    });
    expect(calls.requested).toBe(false); // 검수를 요청하지 않았다
  });

  it('미확정이 남았는데 이대로 시작이 아니면 422 로 건수를 알려 준다', async () => {
    const { svc, calls } = make({ pendingIds: [1, 2], plannedAt: null, budgetOk: true });
    await expect(svc.handoff(1, 9, false)).rejects.toMatchObject({
      reasonCode: 'PLACE_UNRESOLVED',
      status: 422,
      fieldErrors: [{ field: 'pendingCount', message: '2' }],
    });
    expect(calls.requested).toBe(false); // 검수를 요청하지 않았다
  });

  it('이대로 시작이면 남은 곳을 제외하고 검수를 요청한다 (202)', async () => {
    const { svc, calls } = make({ pendingIds: [1, 2], plannedAt: null, budgetOk: true });
    await expect(svc.handoff(1, 9, true)).resolves.toEqual({
      productId: 9,
      plannedAt: '2026-10-01T00:00:00.000Z',
      jobId: 42,
      excludedCount: 2,
    });
    expect(calls.applied).toEqual([1, 2]);
  });

  it('예산 100% 로 검수 요청이 거절되면 되돌려 기획 중에 남긴다', async () => {
    const { svc, calls } = make({ pendingIds: [1], plannedAt: null, budgetOk: false });
    await expect(svc.handoff(1, 9, true)).rejects.toMatchObject({ reasonCode: 'BUDGET_EXHAUSTED' });
    // 방금 처음 찍은 planned_at 이라 다시 비운다
    expect(calls.reverted).toEqual({ ids: [1], clearPlanned: true });
  });
});
