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

  it('🔴 표준보다 느슨한 값은 DB 가 막는다 — 8시간 · 45분은 저장되지 않는다 (DR-CF-008)', async () => {
    /*
     * 화면 · 설정 API 에 이어 세 번째 문이다. 어느 하나를 우회해도 통과하지 않는다.
     * 릴리즈 2 전에는 CHECK 가 1 – 24 · 1 – 240 이라 저장이 됐고 읽을 때 되돌렸다.
     */
    await expect(setR07(8, 60)).rejects.toMatchObject({ code: '23514' });
    await expect(setR07(6, 45)).rejects.toMatchObject({ code: '23514' });

    const s = await repo.find(accountId);
    expect(s.r07SpanHours).toBe(SETTING_DEFAULTS.r07SpanHours);
    expect(s.r07MealMinutes).toBe(SETTING_DEFAULTS.r07MealMinutes);
  });

  it('🔴 판정 기준표는 계정 값이 아니라 표준 시드다 (FR-OP-021)', async () => {
    /*
     * 계정별 기준표 3종과 `r04_threshold` 는 릴리즈 2 에서 지웠다. 계정이 바꿀 수 있는 것은
     * R07 두 값뿐이고, 나머지는 모든 계정이 같은 표준으로 판정한다.
     */
    await setR07(5, 90);
    const s = await repo.find(accountId);

    expect(s.r09IndoorOutdoor).toEqual(INDOOR_OUTDOOR_SEED);
    expect(s.dwellMinutes).toEqual(DWELL_MINUTES_SEED);
    expect(s.r04Threshold).toBe(SETTING_DEFAULTS.r04Threshold);
    // 계정이 바꾼 R07 만 계정 값이다
    expect([s.r07SpanHours, s.r07MealMinutes]).toEqual([5, 90]);
    await setR07(6, 60);
  });

  it('설정 행이 없는 계정은 표준이다', async () => {
    const s = await repo.find(accountId + 1_000_000);
    expect(s.r07SpanHours).toBe(6);
    expect(s.r07MealMinutes).toBe(60);
    expect(s.r04Threshold).toBe(3);
  });
});
