import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ImpactCandidate } from '../batch/impact-finder';
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
    hashFrom: 'a'.repeat(64), hashTo: 'b'.repeat(64),
    changeKey: `FP:${'a'.repeat(64)}:${'b'.repeat(64)}`, body: { condition: 1 },
    ...over,
  } as never);

  describe('중복 방지 (FR-MO-036)', () => {
    it('🔴 지문이 없는 알림도 막힌다 — 조건 2 · 3 (DB 명세서 v1.7)', async () => {
      /*
       * 조건 2 · 3 은 그 콘텐츠가 어느 일정에도 없어 지문 이력이 없다. 지문 두 컬럼을
       * 유니크 키로 쓰던 때는 이 행들이 아무것도 안 막혔다 — 평범한 `UNIQUE` 가 NULL 이
       * 든 행을 서로 다르게 보기 때문이다. 제약은 걸려 있는데 놀고 있었다.
       */
      const near = (over: Record<string, unknown> = {}): Parameters<typeof repo.insertMany>[0][number] =>
        save({ condition: 2, hashFrom: null, hashTo: null, changeKey: 'MT:20260827120000', ...over });

      expect(await repo.insertMany([near()])).toBe(1);
      expect(await repo.insertMany([near()])).toBe(0);
      // 그 콘텐츠가 다시 갱신되면 키가 달라져 새로 뜬다 (FR-MO-036 뒷 문장)
      expect(await repo.insertMany([near({ changeKey: 'MT:20260828090000' })])).toBe(1);
    });

    it('🔴 같은 콘텐츠라도 조건이 다르면 각각 남는다', async () => {
      // 조건 1 은 FP:, 조건 2 는 MT: 라 서로 뭉개지지 않는다
      expect(await repo.insertMany([save()])).toBe(1);
      expect(await repo.insertMany([
        save({ condition: 2, hashFrom: null, hashTo: null, changeKey: 'MT:20260827120000' }),
      ])).toBe(1);
    });

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
      const B = 'b'.repeat(64);
      const C = 'c'.repeat(64);
      await repo.insertMany([save()]);
      expect(await repo.insertMany([
        save({ hashFrom: B, hashTo: C, changeKey: `FP:${B}:${C}` }),
      ])).toBe(1);
    });

    it('🔴 판정하는 것은 키다 — 지문 컬럼이 아니다 (DB 명세서 v1.7)', async () => {
      /*
       * 지문 두 컬럼은 근거 표시용으로 남았다. 키가 같으면 지문이 달라도 같은 변경이고,
       * 키가 다르면 지문이 같아도 다른 변경이다. 둘을 같이 두면 어느 쪽이 판정하는지가
       * 흐려져서, 조건 2 · 3 처럼 지문이 없는 알림이 조용히 안 막힌다.
       */
      await repo.insertMany([save()]);
      // 지문만 바꾸고 키는 그대로 — 같은 변경이다
      expect(await repo.insertMany([save({ hashFrom: null, hashTo: null })])).toBe(0);
      // 키만 바꾸고 지문은 그대로 — 다른 변경이다
      expect(await repo.insertMany([save({ changeKey: 'MT:20260828090000' })])).toBe(1);
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
    /** 한 콘텐츠 몫만 꺼낸다. 저장소는 여러 개를 한 번에 받는다 */
    const forContent = async (contentId: string, today: string): Promise<readonly ImpactCandidate[]> =>
      (await repo.productsWithContents([contentId], today)).get(contentId) ?? [];

    it('조건 1 — 그 콘텐츠를 넣은 상품을 찾는다', async () => {
      const found = await forContent(CONTENT, '2026-08-27');
      expect(found.map((f) => f.productId)).toContain(productId);
      expect(found[0]).toMatchObject({ nights: 2, ldongSignguCd: '150' });
    });

    it('🔴 콘텐츠 여러 개를 한 번에 묻고 콘텐츠별로 묶어 준다', async () => {
      /*
       * 하루 변경이 177건이라 하나씩 물으면 그만큼 왕복한다. 묶는 키가 어긋나면 A 의
       * 변경이 B 를 넣은 상품에 붙는다 — 오류 없이 엉뚱한 상품에 알림이 간다.
       *
       * **콘텐츠 둘이 서로 다른 상품에 붙어 있어야** 잘못 묶은 것이 드러난다. 하나만
       * 두면 전부 한 덩어리로 넣어도 결과가 같다.
       */
      const second = '888888888';
      const other = await pool.query<{ id: string }>(
        `INSERT INTO product (account_id, name, ldong_regn_cd, start_date, nights, transport)
         VALUES ($1, '둘째 상품', '51', '2099-09-10', 2, 'CAR') RETURNING id`, [accountId]);
      const otherId = Number(other.rows[0]?.id);
      await pool.query(
        `INSERT INTO itinerary_item (product_id, day_no, seq, start_time, end_time_source, place_label, item_type, kto_content_id, match_status)
         VALUES ($1, 1, 1, '10:00', 'INPUT', '오죽헌', 'SIGHT', $2, 'CONFIRMED')`, [otherId, second]);

      const missing = '999999999';
      const found = await repo.productsWithContents([CONTENT, second, missing, CONTENT], '2026-08-27');

      expect([...found.keys()].sort()).toEqual([second, CONTENT].sort());
      expect(found.get(CONTENT)?.map((f) => f.productId)).toEqual([productId]);
      expect(found.get(second)?.map((f) => f.productId)).toEqual([otherId]);
      expect(found.get(missing)).toBeUndefined();
    });

    it('미확정 항목은 세지 않는다', async () => {
      await pool.query(`UPDATE itinerary_item SET match_status = 'PENDING' WHERE id = $1`, [itemId]);
      try {
        expect(await forContent(CONTENT, '2026-08-27')).toEqual([]);
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

      const found = await forContent(CONTENT, '2026-08-27');
      expect(found.map((f) => f.productId)).not.toContain(pastId);
      expect(await repo.watchedProducts('2026-08-27')).not.toContainEqual(
        expect.objectContaining({ productId: pastId }),
      );
    });

    it('🔴 상한을 주면 출발일이 임박한 것부터 그만큼만 준다 (FR-MO-020)', async () => {
      // 상한에 걸려 잘려나가는 것은 가장 덜 급한 상품이어야 한다
      const far = await pool.query<{ id: string }>(
        `INSERT INTO product (account_id, name, ldong_regn_cd, start_date, nights, transport)
         VALUES ($1, '먼 미래 상품', '51', '2099-12-31', 1, 'CAR') RETURNING id`, [accountId]);
      const farId = Number(far.rows[0]?.id);

      const all = await repo.watchedProducts('2026-08-27');
      expect(all.map((c) => c.productId)).toContain(farId);

      const capped = await repo.watchedProducts('2026-08-27', all.length - 1);
      expect(capped).toHaveLength(all.length - 1);
      // 가장 늦게 출발하는 것이 잘린다
      expect(capped.map((c) => c.productId)).not.toContain(farId);
    });

    it('출발일 당일과 마지막 날은 아직 감시 대상이다', async () => {
      // 2박 3일이면 출발 + 2일까지다. 그날 아침에도 변경은 의미가 있다
      const found = await forContent(CONTENT, '2099-09-12');
      expect(found.map((f) => f.productId)).toContain(productId);
      expect((await forContent(CONTENT, '2099-09-13')).map((f) => f.productId))
        .not.toContain(productId);
    });
  });
});
