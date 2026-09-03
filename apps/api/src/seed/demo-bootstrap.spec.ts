import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapDemoAccount, seedDemo } from './demo-seed';
import { DEMO_PRODUCTS } from './demo-products';

/**
 * 부팅 시 심사용 계정 보장 (PM-TA-001).
 *
 * 두 가지만 본다 — 비밀번호가 없을 때 조용히 넘어가는가, 그리고 **이미 있는 상품을
 * 건드리지 않는가.** 뒤쪽이 이 함수의 존재 이유다. 심사 도중 재배포가 한 번이라도
 * 걸리면 심사자가 수정하던 상품이 초기 상태로 돌아가기 때문이다.
 */

const URL = process.env.TEST_DATABASE_URL;
if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

const SPEC_EMAIL = 'zz-demo-bootstrap-spec@tourlint.test';

describe('bootstrapDemoAccount — 비밀번호 없음', () => {
  const saved = process.env.DEMO_ACCOUNT_PASSWORD;
  afterEach(() => {
    if (saved === undefined) delete process.env.DEMO_ACCOUNT_PASSWORD;
    else process.env.DEMO_ACCOUNT_PASSWORD = saved;
  });

  it('환경변수가 비면 DB 를 건드리지 않고 건너뛴다', async () => {
    delete process.env.DEMO_ACCOUNT_PASSWORD;
    // 풀을 쓰는 순간 터지는 객체를 넘긴다 — 정말 건드리지 않는지 보려면 이래야 한다
    const exploding = {
      query: () => {
        throw new Error('건너뛰어야 하는데 DB 를 호출했다');
      },
    } as unknown as Pool;

    await expect(bootstrapDemoAccount(exploding)).resolves.toEqual({ status: 'skipped' });
  });
});

describe.skipIf(URL === undefined)('bootstrapDemoAccount — 실 DB', () => {
  let pool: Pool;

  beforeAll(() => {
    process.env.DEMO_ACCOUNT_EMAIL = SPEC_EMAIL;
    process.env.DEMO_ACCOUNT_PASSWORD = 'spec-only-password';
    pool = new Pool({ connectionString: URL, max: 4 });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM account WHERE email = $1`, [SPEC_EMAIL]);
    await pool.end();
  });

  it('계정이 없으면 만들고 시연 상품을 넣는다', async () => {
    await pool.query(`DELETE FROM account WHERE email = $1`, [SPEC_EMAIL]);

    const result = await bootstrapDemoAccount(pool);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.seeded).toBe(DEMO_PRODUCTS.length);

    const demo = await pool.query<{ is_demo: boolean }>(
      `SELECT is_demo FROM account WHERE id = $1`,
      [result.accountId],
    );
    expect(demo.rows[0]?.is_demo).toBe(true);
  });

  it('상품이 이미 있으면 다시 넣지 않는다 — 심사자가 고친 상품을 보존한다', async () => {
    const { accountId } = await seedDemo(pool);
    const target = await pool.query<{ id: string }>(
      `SELECT id FROM product WHERE account_id = $1 ORDER BY id LIMIT 1`,
      [accountId],
    );
    const productId = target.rows[0]?.id;
    expect(productId).toBeDefined();
    await pool.query(`UPDATE product SET name = $1 WHERE id = $2`, ['심사자가 고친 이름', productId]);

    const result = await bootstrapDemoAccount(pool);
    expect(result).toEqual({ status: 'ready', accountId, seeded: 0 });

    const after = await pool.query<{ name: string }>(`SELECT name FROM product WHERE id = $1`, [productId]);
    expect(after.rows[0]?.name).toBe('심사자가 고친 이름');
  });
});
