import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotificationRepository } from './notification.repository';

const URL = process.env.TEST_DATABASE_URL;

if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

describe.skipIf(URL === undefined)('NotificationRepository — 실 DB', () => {
  let pool: Pool;
  let repo: NotificationRepository;
  let accountId: number;
  let productId: number;
  let itemId: number;

  const CONTENT = '125790';
  /** 상품 출발일. 감시 대상에서 빠지지 않게 넉넉히 미래로 둔다 */
  const START = '2099-09-10';

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL });
    repo = new NotificationRepository(pool);

    const acc = await pool.query<{ id: string }>(
      `INSERT INTO account (email, password_hash) VALUES ($1, 'h') RETURNING id`,
      [`notif-${Date.now()}@t.test`],
    );
    accountId = Number(acc.rows[0]?.id);

    const prod = await pool.query<{ id: string }>(
      `INSERT INTO product (account_id, name, ldong_regn_cd, ldong_signgu_cd, start_date, nights, transport)
       VALUES ($1, '강릉 2박3일', '51', '150', $2, 2, 'CHARTER_BUS') RETURNING id`,
      [accountId, START],
    );
    productId = Number(prod.rows[0]?.id);

    const it = await pool.query<{ id: string }>(
      `INSERT INTO itinerary_item
         (product_id, day_no, seq, start_time, end_time_source, place_label, item_type, kto_content_id, match_status)
       VALUES ($1, 1, 1, '10:00', 'INPUT', '경포대', 'SIGHT', $2, 'CONFIRMED') RETURNING id`,
      [productId, CONTENT],
    );
    itemId = Number(it.rows[0]?.id);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM account WHERE id = $1`, [accountId]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM notification WHERE product_id = $1`, [productId]);
  });

  const save = (over: Record<string, unknown> = {}): Parameters<typeof repo.insertMany>[0][number] => ({
    productId, kind: 'RISK', condition: 1, ktoContentId: CONTENT,
    hashFrom: 'a'.repeat(64), hashTo: 'b'.repeat(64), body: { condition: 1 },
    ...over,
  } as never);

  describe('중복 방지 (FR-MO-036)', () => {
    it('🔴 같은 콘텐츠의 같은 변경은 다시 넣지 않는다', async () => {
      // 배치가 같은 날짜를 다시 볼 수 있다 (0건 재조회 · 실패 재시도). 중복 시도는 정상이다
      expect(await repo.insertMany([save()])).toBe(1);
      expect(await repo.insertMany([save()])).toBe(0);

      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM notification WHERE product_id = $1`, [productId]);
      expect(Number(rows[0]?.n)).toBe(1);
    });

    it('🔴 새로운 변경이면 다시 노출된다', async () => {
      // 무시한 알림이 영영 안 뜨는 것이 아니라, 그 변경에 대해서만 안 뜬다
      await repo.insertMany([save()]);
      expect(await repo.insertMany([save({ hashFrom: 'b'.repeat(64), hashTo: 'c'.repeat(64) })])).toBe(1);
    });

    it('다른 상품은 각각 들어간다', async () => {
      const other = await pool.query<{ id: string }>(
        `INSERT INTO product (account_id, name, ldong_regn_cd, start_date, nights, transport)
         VALUES ($1, '다른 상품', '51', $2, 0, 'CAR') RETURNING id`, [accountId, START]);
      const otherId = Number(other.rows[0]?.id);
      expect(await repo.insertMany([save(), save({ productId: otherId })])).toBe(2);
    });
  });

  describe('후보 탐색 (FR-MO-018 · 030)', () => {
    it('조건 1 — 그 콘텐츠를 넣은 상품을 찾는다', async () => {
      const found = await repo.productsWithContent(CONTENT, '2026-08-27');
      expect(found.map((f) => f.productId)).toContain(productId);
      expect(found[0]).toMatchObject({ nights: 2, ldongSignguCd: '150' });
    });

    it('미확정 항목은 세지 않는다', async () => {
      await pool.query(`UPDATE itinerary_item SET match_status = 'PENDING' WHERE id = $1`, [itemId]);
      try {
        expect(await repo.productsWithContent(CONTENT, '2026-08-27')).toEqual([]);
      } finally {
        await pool.query(`UPDATE itinerary_item SET match_status = 'CONFIRMED' WHERE id = $1`, [itemId]);
      }
    });

    it('🔴 출발일이 지난 상품은 감시하지 않는다 (FR-MO-018)', async () => {
      // 이미 다녀온 일정에 알림을 보내도 할 수 있는 게 없다. 수동 재검수는 계속 된다
      const past = await pool.query<{ id: string }>(
        `INSERT INTO product (account_id, name, ldong_regn_cd, start_date, nights, transport)
         VALUES ($1, '지난 상품', '51', '2020-01-01', 1, 'CAR') RETURNING id`, [accountId]);
      const pastId = Number(past.rows[0]?.id);
      await pool.query(
        `INSERT INTO itinerary_item (product_id, day_no, seq, start_time, end_time_source, place_label, item_type, kto_content_id, match_status)
         VALUES ($1, 1, 1, '10:00', 'INPUT', '경포대', 'SIGHT', $2, 'CONFIRMED')`, [pastId, CONTENT]);

      const found = await repo.productsWithContent(CONTENT, '2026-08-27');
      expect(found.map((f) => f.productId)).not.toContain(pastId);
      expect(await repo.watchedProducts('2026-08-27')).not.toContainEqual(
        expect.objectContaining({ productId: pastId }),
      );
    });

    it('출발일 당일과 마지막 날은 아직 감시 대상이다', async () => {
      // 2박 3일이면 출발 + 2일까지다. 그날 아침에도 변경은 의미가 있다
      const found = await repo.productsWithContent(CONTENT, '2099-09-12');
      expect(found.map((f) => f.productId)).toContain(productId);
      expect((await repo.productsWithContent(CONTENT, '2099-09-13')).map((f) => f.productId))
        .not.toContain(productId);
    });
  });
});
