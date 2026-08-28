import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_PRODUCTS } from './demo-products';
import { seedDemo } from './demo-seed';

/**
 * 데모 시드 — 실 DB. 계정 생성·상품 재적재·복원 멱등을 본다.
 *
 * 스키마 CHECK 와 트리거가 걸려 있어 가짜 커넥션으로는 아무것도 검증되지 않는다. 실제 데모
 * 이메일을 건드리지 않도록 스펙 전용 이메일을 환경변수로 주입한다.
 */

const URL = process.env.TEST_DATABASE_URL;
if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

const SPEC_EMAIL = 'zz-demo-seed-spec@tourlint.test';
const ITEM_TOTAL = DEMO_PRODUCTS.reduce((sum, p) => sum + p.items.length, 0);

describe.skipIf(URL === undefined)('seedDemo', () => {
  let pool: Pool;

  beforeAll(() => {
    process.env.DEMO_ACCOUNT_EMAIL = SPEC_EMAIL;
    process.env.DEMO_ACCOUNT_PASSWORD = 'spec-only-password';
    pool = new Pool({ connectionString: URL, max: 4 });
  });

  afterAll(async () => {
    // 계정을 지우면 product · itinerary_item · user_setting 이 CASCADE 로 함께 지워진다
    await pool.query(`DELETE FROM account WHERE email = $1`, [SPEC_EMAIL]);
    await pool.end();
  });

  const counts = async (accountId: number): Promise<{ products: number; items: number }> => {
    const p = await pool.query<{ n: string }>(`SELECT count(*)::text n FROM product WHERE account_id = $1`, [accountId]);
    const i = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM itinerary_item it
         JOIN product pr ON pr.id = it.product_id WHERE pr.account_id = $1`,
      [accountId],
    );
    return { products: Number(p.rows[0]?.n ?? 0), items: Number(i.rows[0]?.n ?? 0) };
  };

  it('계정과 시연 상품을 만든다', async () => {
    const { accountId, products } = await seedDemo(pool);
    expect(products).toBe(DEMO_PRODUCTS.length);

    const demo = await pool.query<{ is_demo: boolean }>(`SELECT is_demo FROM account WHERE id = $1`, [accountId]);
    expect(demo.rows[0]?.is_demo).toBe(true);

    const c = await counts(accountId);
    expect(c.products).toBe(DEMO_PRODUCTS.length);
    expect(c.items).toBe(ITEM_TOTAL);
  });

  it('다시 시드해도 계정은 하나, 상품 수는 그대로다 (복원 멱등)', async () => {
    const first = await seedDemo(pool);
    const second = await seedDemo(pool);
    expect(second.accountId).toBe(first.accountId);

    const accounts = await pool.query<{ n: string }>(`SELECT count(*)::text n FROM account WHERE email = $1`, [SPEC_EMAIL]);
    expect(Number(accounts.rows[0]?.n)).toBe(1);

    const c = await counts(second.accountId);
    expect(c.products).toBe(DEMO_PRODUCTS.length);
    expect(c.items).toBe(ITEM_TOTAL);
  });
});
