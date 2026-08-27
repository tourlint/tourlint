import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateCreate } from './product.dto';
import { ProductRepository } from './product.repository';

/**
 * 상품 CRUD 리포지토리 — 실 DB. 스키마 CHECK·트리거(day_no ≤ nights+1)·CASCADE 가 걸려 있어
 * 가짜 커넥션으로는 검증되지 않는다. 계정 스코프(남의 상품은 안 보인다)도 여기서 본다.
 */

const URL = process.env.TEST_DATABASE_URL;
if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

const EMAIL_A = 'zz-product-spec-a@tourlint.test';
const EMAIL_B = 'zz-product-spec-b@tourlint.test';

function sample() {
  const { product } = validateCreate({
    name: '강릉 CRUD 스펙 2박 3일',
    ldongRegnCd: '51',
    ldongSignguCd: '150',
    startDate: '2026-10-22',
    nights: 2,
    transport: 'CAR',
    headCount: 10,
    days: [
      { day: 1, items: [{ start: '10:00', end: '11:30', place: '경포대', itemType: 'SIGHT' }] },
      { day: 2, items: [{ start: '09:00', end: '', place: '오죽헌', itemType: 'SIGHT' }] },
      { day: 3, items: [{ start: '12:00', end: '13:00', place: '초당순두부', itemType: 'MEAL' }] },
    ],
  });
  if (product === null) throw new Error('샘플 검증 실패');
  return product;
}

describe.skipIf(URL === undefined)('ProductRepository', () => {
  let pool: Pool;
  let repo: ProductRepository;
  let accountA: number;
  let accountB: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 4 });
    repo = new ProductRepository(pool);
    accountA = await makeAccount(pool, EMAIL_A);
    accountB = await makeAccount(pool, EMAIL_B);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM account WHERE email = ANY($1)`, [[EMAIL_A, EMAIL_B]]);
    await pool.end();
  });

  it('상품과 일정을 만들고 상세로 되읽는다', async () => {
    const created = await repo.create(accountA, sample());
    expect(created.dayCount).toBe(3);

    const detail = await repo.detail(accountA, created.productId);
    expect(detail).not.toBeNull();
    const itemCount = detail?.items.length ?? 0;
    expect(itemCount).toBe(3);
    // 등록 시점 항목은 관광지 미확정이라 PENDING 이다
    expect(detail?.items.every((i) => i.matchStatus === 'PENDING')).toBe(true);
  });

  it('목록은 자기 계정 상품만 보여준다 (계정 격리)', async () => {
    const listA = await repo.list(accountA, 0, 20);
    const listB = await repo.list(accountB, 0, 20);
    expect(listA.total).toBeGreaterThan(0);
    expect(listB.total).toBe(0);
    // 아직 검수 전이라 latestAudit 은 null, 항목은 전부 PENDING
    expect(listA.rows[0]?.latestAudit).toBeNull();
    expect(listA.rows[0]?.pendingMatches).toBe(3);
  });

  it('남의 상품은 상세·수정·삭제가 안 된다', async () => {
    const created = await repo.create(accountA, sample());
    expect(await repo.detail(accountB, created.productId)).toBeNull();
    expect(await repo.updateBasic(accountB, created.productId, { name: '탈취' })).toBe(false);
    expect(await repo.remove(accountB, created.productId)).toBe(false);
    // 주인은 된다
    expect(await repo.updateBasic(accountA, created.productId, { name: '수정됨' })).toBe(true);
    expect((await repo.detail(accountA, created.productId))?.name).toBe('수정됨');
  });

  it('삭제하면 일정 항목도 CASCADE 로 함께 지워진다', async () => {
    const created = await repo.create(accountA, sample());
    expect(await repo.remove(accountA, created.productId)).toBe(true);
    const items = await pool.query(`SELECT 1 FROM itinerary_item WHERE product_id = $1`, [created.productId]);
    expect(items.rowCount).toBe(0);
  });
});

async function makeAccount(pool: Pool, email: string): Promise<number> {
  await pool.query(`DELETE FROM account WHERE email = $1`, [email]);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO account (email, password_hash, is_demo) VALUES ($1, 'x', FALSE) RETURNING id`,
    [email],
  );
  const id = rows[0];
  if (id === undefined) throw new Error('계정 생성 실패');
  await pool.query(`INSERT INTO user_setting (account_id) VALUES ($1)`, [id.id]);
  return Number(id.id);
}
