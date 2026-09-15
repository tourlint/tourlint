import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DWELL_MINUTES_SEED, INDOOR_OUTDOOR_SEED, SETTING_DEFAULTS } from '@tourlint/shared';
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

  const setR07 = (span: number, meal: number) =>
    pool.query(`UPDATE user_setting SET r07_span_hours = $2, r07_meal_minutes = $3 WHERE account_id = $1`,
      [accountId, span, meal]);

  it('🔴 회사 기준(R07 두 값)은 계정 값을 읽는다 (FR-OP-022)', async () => {
    await setR07(5, 90);
    const s = await repo.find(accountId);
    expect(s.r07SpanHours).toBe(5);
    expect(s.r07MealMinutes).toBe(90);
    await setR07(6, 60);
  });

  it('🔴 표준보다 느슨한 값은 표준으로 읽는다 — 릴리즈 2 전 DB 에 남은 8시간 · 45분 (DR-CF-008)', async () => {
    await setR07(8, 45);
    const s = await repo.find(accountId);
    expect(s.r07SpanHours).toBe(SETTING_DEFAULTS.r07SpanHours);
    expect(s.r07MealMinutes).toBe(SETTING_DEFAULTS.r07MealMinutes);
    await setR07(6, 60);
  });

  it('🔴 계정 표를 고쳐도 판정 기준표는 표준 시드다 (FR-OP-021)', async () => {
    /*
     * 표 3종과 `r04_threshold` 는 릴리즈 2 까지 남아 있다. 옛 설정 화면으로 값이 들어가도
     * 판정은 모든 계정이 같은 표준으로 해야 한다.
     */
    await pool.query(
      `INSERT INTO indoor_outdoor_map (account_id, lcls_systm2, space_type) VALUES ($1, 'HS01', 'INDOOR')
       ON CONFLICT (account_id, lcls_systm2) DO UPDATE SET space_type = 'INDOOR'`,
      [accountId]);
    await pool.query(
      `INSERT INTO dwell_default (account_id, lcls_systm2, minutes) VALUES ($1, 'EV01', 15)
       ON CONFLICT (account_id, lcls_systm2) DO UPDATE SET minutes = 15`,
      [accountId]);
    await pool.query(`UPDATE user_setting SET r04_threshold = 5 WHERE account_id = $1`, [accountId]);

    const s = await repo.find(accountId);
    expect(s.r09IndoorOutdoor).toEqual(INDOOR_OUTDOOR_SEED);
    expect(s.dwellMinutes).toEqual(DWELL_MINUTES_SEED);
    expect(s.r04Threshold).toBe(SETTING_DEFAULTS.r04Threshold);

    await pool.query(`DELETE FROM indoor_outdoor_map WHERE account_id = $1`, [accountId]);
    await pool.query(`DELETE FROM dwell_default WHERE account_id = $1`, [accountId]);
    await pool.query(`UPDATE user_setting SET r04_threshold = 3 WHERE account_id = $1`, [accountId]);
  });

  it('설정 행이 없는 계정은 표준이다', async () => {
    const s = await repo.find(accountId + 1_000_000);
    expect(s.r07SpanHours).toBe(6);
    expect(s.r07MealMinutes).toBe(60);
    expect(s.r04Threshold).toBe(3);
  });
});
