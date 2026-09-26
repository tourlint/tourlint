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
      matchedBy: 'USER',
    });
    const { rows } = await pool.query<{ match_status: string; kto_content_id: string; mapx: string | null; matched_by: string | null }>(
      `SELECT match_status, kto_content_id, mapx, matched_by FROM itinerary_item WHERE id = $1`,
      [itemId],
    );
    expect(rows[0]?.match_status).toBe('CONFIRMED');
    expect(rows[0]?.kto_content_id).toBe('125790');
    expect(Number(rows[0]?.mapx)).toBeCloseTo(128.896483, 4);
    expect(rows[0]?.matched_by).toBe('USER');
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

  it('🔴 이름을 저장하지 않은 고른 곳은 준 이름으로 제외한다 — 이름이 있는 줄은 그 이름을 둔다 (ck_item_label_required)', async () => {
    const { rows: [picked] } = await pool.query<{ id: string; product_id: string }>(
      `INSERT INTO itinerary_item (product_id, day_no, seq, start_time, end_time_source, place_label, item_type, match_status, kto_content_id, content_type_id)
       SELECT product_id, 1, 2, '18:00', 'DWELL_DEFAULT', NULL, 'LODGING', 'CONFIRMED', '142785', 32 FROM itinerary_item WHERE id = $1
       RETURNING id, product_id`,
      [itemId],
    );
    const nameless = Number(picked?.id);
    expect((await repo.findItem(accountA, nameless))?.placeLabel).toBeNull();
    await repo.exclude(nameless, '세인트존스');
    // 수정안을 거친 줄은 이름이 빈 글로 남는다 — 그 줄도 준 이름으로 채운다
    const { rows: [blank] } = await pool.query<{ id: string }>(
      `INSERT INTO itinerary_item (product_id, day_no, seq, start_time, end_time_source, place_label, item_type, match_status, kto_content_id, content_type_id)
       SELECT product_id, 1, 3, '20:00', 'DWELL_DEFAULT', '', 'SIGHT', 'CONFIRMED', '126175', 12 FROM itinerary_item WHERE id = $1
       RETURNING id`,
      [itemId],
    );
    await repo.exclude(Number(blank?.id), '등대 산책');
    // 이름이 있는 줄(경포대)에 이름을 줘도 바꾸지 않는다
    await repo.exclude(itemId, '다른 이름');
    const { rows } = await pool.query<{ id: string; match_status: string; place_label: string | null }>(
      `SELECT id, match_status, place_label FROM itinerary_item WHERE id = ANY($1) ORDER BY seq`, [[itemId, nameless, Number(blank?.id)]],
    );
    expect(rows.map((r) => [r.match_status, r.place_label])).toEqual([
      ['EXCLUDED', '경포대'], ['EXCLUDED', '세인트존스'], ['EXCLUDED', '등대 산책'],
    ]);
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
