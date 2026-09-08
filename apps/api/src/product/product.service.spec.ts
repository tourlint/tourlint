import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaceNameResolver } from '../audit/place-name';
import { CatalogService } from '../catalog/catalog.service';
import { InMemoryApiCallLogger } from '../external/api-call-log';
import { FixtureKtoTransport, KtoClient } from '../external/kto';
import { PatchApplicationRepository } from '../persistence/patch-application.repository';
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
      new PlaceNameResolver({ kto: kto() }),
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
});
