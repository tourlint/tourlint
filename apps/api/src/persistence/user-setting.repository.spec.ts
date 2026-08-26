import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DWELL_MINUTES_SEED, INDOOR_OUTDOOR_SEED } from '@tourlint/shared';
import { AccountRepository } from '../auth/account.repository';
import { UserSettingRepository } from './user-setting.repository';

const URL = process.env.TEST_DATABASE_URL;

if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

describe.skipIf(URL === undefined)('UserSettingRepository — 실 DB', () => {
  let pool: Pool;
  let repo: UserSettingRepository;
  let accountId: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL });
    repo = new UserSettingRepository(pool);
    const account = await new AccountRepository(pool).create(`set-${Date.now()}@t.test`, 'hash');
    accountId = account.id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM account WHERE id = $1`, [accountId]);
    await pool.end();
  });

  it('🔴 계정을 만들면 실내외 59행 · 체류시간 47행이 함께 생긴다', async () => {
    const io = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM indoor_outdoor_map WHERE account_id = $1`, [accountId]);
    const dw = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM dwell_default WHERE account_id = $1`, [accountId]);
    expect(Number(io.rows[0]?.n)).toBe(59);
    expect(Number(dw.rows[0]?.n)).toBe(Object.keys(DWELL_MINUTES_SEED).length);
  });

  it('DB 값을 그대로 읽는다', async () => {
    const s = await repo.find(accountId);
    expect(s.r09IndoorOutdoor.HS01).toBe('OUTDOOR');
    expect(s.r09IndoorOutdoor.VE07).toBe('INDOOR');
    expect(s.dwellMinutes.EV01).toBe(120);
    expect(Object.keys(s.r09IndoorOutdoor)).toHaveLength(59);
  });

  it('🔴 설정을 고치면 그 값으로 읽힌다 — 상수가 아니라 DB 를 본다 (FR-OP-021)', async () => {
    await pool.query(
      `UPDATE indoor_outdoor_map SET space_type = 'INDOOR' WHERE account_id = $1 AND lcls_systm2 = 'HS01'`,
      [accountId]);
    await pool.query(`UPDATE user_setting SET r04_threshold = 5 WHERE account_id = $1`, [accountId]);

    const s = await repo.find(accountId);
    expect(s.r09IndoorOutdoor.HS01).toBe('INDOOR');
    expect(s.r04Threshold).toBe(5);
    // 상수는 그대로다
    expect(INDOOR_OUTDOOR_SEED.HS01).toBe('OUTDOOR');

    await pool.query(
      `UPDATE indoor_outdoor_map SET space_type = 'OUTDOOR' WHERE account_id = $1 AND lcls_systm2 = 'HS01'`,
      [accountId]);
    await pool.query(`UPDATE user_setting SET r04_threshold = 3 WHERE account_id = $1`, [accountId]);
  });

  it('🔴 표가 비면 상수로 돌아간다 — 빈 매핑으로 판정하지 않는다', async () => {
    /*
     * 빈 매핑을 그대로 쓰면 R09 가 모든 항목을 「매핑 없음」으로 보고 야외 비중을 못 세
     * 상품 전체가 확인 불가가 된다. 기본 데이터가 안 들어간 것이 판정으로 새면 안 된다.
     */
    const other = await new AccountRepository(pool).create(`empty-${Date.now()}@t.test`, 'hash');
    try {
      await pool.query(`DELETE FROM indoor_outdoor_map WHERE account_id = $1`, [other.id]);
      await pool.query(`DELETE FROM dwell_default WHERE account_id = $1`, [other.id]);

      const s = await repo.find(other.id);
      expect(s.r09IndoorOutdoor).toEqual(INDOOR_OUTDOOR_SEED);
      expect(s.dwellMinutes).toEqual(DWELL_MINUTES_SEED);
    } finally {
      await pool.query(`DELETE FROM account WHERE id = $1`, [other.id]);
    }
  });

  it('설정 행이 없는 계정은 기본값이다', async () => {
    const s = await repo.find(accountId + 1_000_000);
    expect(s.r07SpanHours).toBe(6);
    expect(s.r04Threshold).toBe(3);
  });
});
