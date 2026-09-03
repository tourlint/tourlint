import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DWELL_MINUTES_SEED, INDOOR_OUTDOOR_SEED, TARGET_PROFILE_SEED } from '@tourlint/shared';
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

  const defaults = async (accountId: number) => {
    const one = async (table: string): Promise<number> => {
      const r = await pool.query<{ n: string }>(
        `SELECT count(*)::text n FROM ${table} WHERE account_id = $1`, [accountId]);
      return Number(r.rows[0]?.n ?? 0);
    };
    return {
      target: await one('target_profile'),
      io: await one('indoor_outdoor_map'),
      dwell: await one('dwell_default'),
      setting: await one('user_setting'),
    };
  };

  it('🔴 계정 기본 데이터 3종을 채운다 — 비면 R10 이 확인 불가로 물러난다', async () => {
    /*
     * 운영 데모 계정이 `target_profile 0/63` 인 채로 돌아 TP-03 이 명세 AC 의 29점이
     * 아니라 27점이 나왔다 (이슈 #310). 시드가 `user_setting` 만 넣고 나머지를 빠뜨렸다.
     *
     * **계정을 먼저 지운다.** 안 지우면 앞 테스트가 만든 계정이 남아 「기존 계정」 경로로
     * 흘러 신규 생성 경로를 안 밟는다 — 그 상태로는 생성 경로를 되돌려도 초록이었다.
     */
    await pool.query(`DELETE FROM account WHERE email = $1`, [SPEC_EMAIL]);
    const { accountId } = await seedDemo(pool);
    expect(await defaults(accountId)).toEqual({
      target: TARGET_PROFILE_SEED.length,
      io: Object.keys(INDOOR_OUTDOOR_SEED).length,
      dwell: Object.keys(DWELL_MINUTES_SEED).length,
      setting: 1,
    });
  });

  it('🔴 이미 있는 계정에도 채운다 — 비어 있던 계정이 시드로 복구된다', async () => {
    // 조회 후 바로 반환하면 그때 빠진 계정은 영영 비어 있다
    const { accountId } = await seedDemo(pool);
    await pool.query(`DELETE FROM target_profile WHERE account_id = $1`, [accountId]);
    expect((await defaults(accountId)).target).toBe(0);

    await seedDemo(pool);
    expect((await defaults(accountId)).target).toBe(TARGET_PROFILE_SEED.length);
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
