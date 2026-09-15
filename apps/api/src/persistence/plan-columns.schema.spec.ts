import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALL_PROVIDER } from '@tourlint/shared';

/**
 * 릴리즈 1 마이그레이션(2026-09-14_standard_and_plan)이 더한 컬럼 · 제약 (DB 명세서 v2.3).
 *
 * 기획 화면이 넣는 항목은 장소명이 비거나(고른 곳) 걷기 길 식별자만 가진다. 앱이 막는 것과
 * 별개로 DB 가 마지막으로 막아야 하는 조합이 여기 있다.
 */

const ROOT = join(__dirname, '../../../..');

/** CHECK 정의에서 IN (...) 목록을 뽑는다 */
function inList(sql: string, constraint: string): string[] {
  const at = sql.indexOf(`CONSTRAINT ${constraint}`);
  if (at < 0) throw new Error(`${constraint} 없음`);
  const body = sql.slice(at, sql.indexOf(')', sql.indexOf('(', sql.indexOf(' IN', at)) + 1) + 1);
  return [...body.matchAll(/'([A-Z_0-9]+)'/g)].map((m) => m[1] as string);
}

describe('호출 로그 제공자 목록이 공용 상수와 같다', () => {
  it('🔴 schema.sql 과 마이그레이션의 ck_log_provider 가 CALL_PROVIDER 9값이다', () => {
    const schema = readFileSync(join(ROOT, 'db/schema.sql'), 'utf8');
    const migration = readFileSync(join(ROOT, 'db/migrations/2026-09-14_standard_and_plan.sql'), 'utf8');
    expect(inList(schema, 'ck_log_provider')).toEqual([...CALL_PROVIDER]);
    expect(inList(migration, 'ck_log_provider')).toEqual([...CALL_PROVIDER]);
  });
});

const URL = process.env.TEST_DATABASE_URL;

if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

describe.skipIf(URL === undefined)('기획 · 에이전트 컬럼 제약 — 실 DB', () => {
  let pool: Pool;
  let accountId: number;
  let productId: number;
  const MARK = `plan-schema-${Date.now()}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL });
    const acc = await pool.query<{ id: string }>(
      `INSERT INTO account (email, password_hash, is_demo) VALUES ($1, 'x', FALSE) RETURNING id`,
      [`${MARK}@t.test`],
    );
    accountId = Number(acc.rows[0]?.id);
    const prod = await pool.query<{ id: string }>(
      `INSERT INTO product (account_id, name, ldong_regn_cd, ldong_signgu_cd, start_date, transport)
       VALUES ($1, '제약 확인', '51', '150', '2026-10-23', 'CAR') RETURNING id`,
      [accountId],
    );
    productId = Number(prod.rows[0]?.id);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM account WHERE id = $1`, [accountId]);
    await pool.query(`DELETE FROM api_call_log WHERE operation = $1`, [MARK]);
    await pool.query(`DELETE FROM demand_signal WHERE region_key = $1`, [MARK]);
    await pool.end();
  });

  let seq = 0;
  function item(values: {
    matchStatus: 'CONFIRMED' | 'EXCLUDED' | 'PENDING';
    placeLabel: string | null;
    walkId?: string | null;
    contentId?: string | null;
    matchedBy?: string | null;
    origin?: string | null;
  }) {
    seq += 1;
    return pool.query(
      `INSERT INTO itinerary_item
         (product_id, day_no, seq, start_time, end_time_source, place_label, item_type,
          kto_content_id, match_status, walk_id, matched_by, origin)
       VALUES ($1, 1, $2, '10:00', 'DWELL_FALLBACK', $3, 'SIGHT', $4, $5, $6, $7, $8)`,
      [
        productId,
        seq,
        values.placeLabel,
        values.contentId ?? (values.matchStatus === 'CONFIRMED' ? '125769' : null),
        values.matchStatus,
        values.walkId ?? null,
        values.matchedBy ?? null,
        values.origin ?? null,
      ],
    );
  }

  const rejectedBy = (constraint: string) =>
    expect.objectContaining({ code: '23514', constraint });

  it('고른 곳(CONFIRMED)은 장소명이 비어도 된다', async () => {
    await expect(item({ matchStatus: 'CONFIRMED', placeLabel: null })).resolves.toBeDefined();
  });

  it('🔴 걷기 길이 아닌 직접 정한 곳 · 아직 고르지 않은 곳은 장소명이 있어야 한다 (ck_item_label_required)', async () => {
    await expect(item({ matchStatus: 'EXCLUDED', placeLabel: null })).rejects.toEqual(rejectedBy('ck_item_label_required'));
    await expect(item({ matchStatus: 'PENDING', placeLabel: null })).rejects.toEqual(rejectedBy('ck_item_label_required'));
  });

  it('걷기 길은 직접 정한 곳으로 식별자만 두고 장소명을 비울 수 있다', async () => {
    await expect(
      item({ matchStatus: 'EXCLUDED', placeLabel: null, walkId: 'T_CRS_MNG0000005118' }),
    ).resolves.toBeDefined();
  });

  it('🔴 고른 곳에 걷기 길 식별자를 둘 수 없다 (ck_item_walk)', async () => {
    await expect(
      item({ matchStatus: 'CONFIRMED', placeLabel: '해변', walkId: 'T_CRS_MNG0000005118' }),
    ).rejects.toEqual(rejectedBy('ck_item_walk'));
  });

  it('🔴 고른 방식 · 들어온 경로는 정한 값만 (ck_item_matched_by · ck_item_origin)', async () => {
    await expect(item({ matchStatus: 'CONFIRMED', placeLabel: null, matchedBy: 'AGENT', origin: 'PICKER' })).resolves.toBeDefined();
    await expect(item({ matchStatus: 'CONFIRMED', placeLabel: null, matchedBy: 'LLM' })).rejects.toEqual(rejectedBy('ck_item_matched_by'));
    await expect(item({ matchStatus: 'CONFIRMED', placeLabel: null, origin: 'AGENT' })).rejects.toEqual(rejectedBy('ck_item_origin'));
  });

  it('🔴 호출 로그는 반려동물 서비스를 따로 받고 목록 밖 제공자는 거부한다 (ck_log_provider)', async () => {
    const log = (provider: string) =>
      pool.query(
        `INSERT INTO api_call_log (provider, operation, called_at, quota_date, status, latency_ms)
         VALUES ($1, $2, now(), CURRENT_DATE, 'OK', 1)`,
        [provider, MARK],
      );
    await expect(log('KTO_PET')).resolves.toBeDefined();
    await expect(log('KTO_DATALAB')).rejects.toEqual(rejectedBy('ck_log_provider'));
  });

  it('🔴 수요 신호는 T3 를 받는다 (ck_signal_type)', async () => {
    const signal = (type: string) =>
      pool.query(
        `INSERT INTO demand_signal
           (signal_type, region_key, ldong_regn_cd, window_from, window_to, total_count, by_type, computed_at)
         VALUES ($1, $2, '51', '2025-10-01', '2025-10-31', 0, '{}', now())`,
        [type, MARK],
      );
    await expect(signal('T3')).resolves.toBeDefined();
    await expect(signal('T4')).rejects.toEqual(rejectedBy('ck_signal_type'));
  });

  it('새 컬럼의 기본값 — 관심 지역 · 변경 이력은 빈 배열, 키워드 일치는 빈 객체', async () => {
    await pool.query(`INSERT INTO user_setting (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING`, [accountId]);
    const s = await pool.query<{ watch_regions: unknown; r07_history: unknown }>(
      `SELECT watch_regions, r07_history FROM user_setting WHERE account_id = $1`,
      [accountId],
    );
    expect(s.rows[0]).toEqual({ watch_regions: [], r07_history: [] });
    const d = await pool.query<{ by_keyword: unknown }>(
      `SELECT by_keyword FROM demand_signal WHERE region_key = $1 LIMIT 1`,
      [MARK],
    );
    expect(d.rows[0]?.by_keyword).toEqual({});
  });
});
