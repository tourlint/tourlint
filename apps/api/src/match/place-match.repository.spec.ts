import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaceMatchRepository } from './place-match.repository';

/**
 * 관광지 확정 쓰기 — 실 DB. 계정 격리(남의 항목은 못 찾는다)와 CONFIRMED/EXCLUDED 제약을 본다.
 */

const URL = process.env.TEST_DATABASE_URL;
if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

const EMAIL_A = 'zz-match-spec-a@tourlint.test';
const EMAIL_B = 'zz-match-spec-b@tourlint.test';

describe.skipIf(URL === undefined)('PlaceMatchRepository', () => {
  let pool: Pool;
  let repo: PlaceMatchRepository;
  let accountA: number;
  let accountB: number;
  let itemId: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 4 });
    repo = new PlaceMatchRepository(pool);
    accountA = await makeAccount(pool, EMAIL_A);
    accountB = await makeAccount(pool, EMAIL_B);
    const p = await pool.query<{ id: string }>(
      `INSERT INTO product (account_id, name, ldong_regn_cd, ldong_signgu_cd, start_date, nights, transport)
       VALUES ($1,'매칭 스펙','51','150','2026-10-22',0,'CAR') RETURNING id`,
      [accountA],
    );
    const productId = Number(p.rows[0]?.id);
    const it = await pool.query<{ id: string }>(
      `INSERT INTO itinerary_item (product_id, day_no, seq, start_time, end_time_source, place_label, item_type, match_status)
       VALUES ($1,1,1,'10:00','DWELL_DEFAULT','경포대','SIGHT','PENDING') RETURNING id`,
      [productId],
    );
    itemId = Number(it.rows[0]?.id);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM account WHERE email = ANY($1)`, [[EMAIL_A, EMAIL_B]]);
    await pool.end();
  });

  it('남의 계정으로는 항목을 못 찾는다', async () => {
    expect(await repo.findItem(accountB, itemId)).toBeNull();
    const mine = await repo.findItem(accountA, itemId);
    expect(mine?.ldongRegnCd).toBe('51');
  });

  it('확정하면 CONFIRMED 로 바뀌고 좌표·분류가 붙는다', async () => {
    await repo.confirm(itemId, {
      contentId: '125790',
      contentTypeId: 12,
      lclsSystm1: 'HS',
      lclsSystm2: 'HS01',
      lclsSystm3: 'HS011200',
      mapx: 128.896483,
      mapy: 37.795513,
    });
    const { rows } = await pool.query<{ match_status: string; kto_content_id: string; mapx: string | null }>(
      `SELECT match_status, kto_content_id, mapx FROM itinerary_item WHERE id = $1`,
      [itemId],
    );
    expect(rows[0]?.match_status).toBe('CONFIRMED');
    expect(rows[0]?.kto_content_id).toBe('125790');
    expect(Number(rows[0]?.mapx)).toBeCloseTo(128.896483, 4);
  });

  it('제외하면 EXCLUDED 이고 contentid·좌표가 지워진다 (ck_item_match_content)', async () => {
    await repo.exclude(itemId);
    const { rows } = await pool.query<{ match_status: string; kto_content_id: string | null; mapx: string | null }>(
      `SELECT match_status, kto_content_id, mapx FROM itinerary_item WHERE id = $1`,
      [itemId],
    );
    expect(rows[0]?.match_status).toBe('EXCLUDED');
    expect(rows[0]?.kto_content_id).toBeNull();
    expect(rows[0]?.mapx).toBeNull();
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
