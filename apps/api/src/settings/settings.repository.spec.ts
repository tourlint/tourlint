import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountRepository } from '../auth/account.repository';
import { ACCOUNT_SETTING_DEFAULTS, SettingsRepository } from './settings.repository';

const URL = process.env.TEST_DATABASE_URL;

if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

describe.skipIf(URL === undefined)('SettingsRepository — 실 DB', () => {
  let pool: Pool;
  let repo: SettingsRepository;
  let a1: number;
  let a2: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL });
    repo = new SettingsRepository(pool);
    const acc = new AccountRepository(pool);
    a1 = (await acc.create(`set1-${Date.now()}@t.test`, 'hash')).id;
    a2 = (await acc.create(`set2-${Date.now()}@t.test`, 'hash')).id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM account WHERE id = ANY($1)`, [[a1, a2]]);
    await pool.end();
  });

  it('저장한 적 없으면 기본값을 읽는다', async () => {
    const s = await repo.accountSettings(a1);
    expect(s.r04Threshold).toBe(ACCOUNT_SETTING_DEFAULTS.r04Threshold);
    expect(s.weights).toEqual(ACCOUNT_SETTING_DEFAULTS.weights);
    expect(s.watchKeywords).toEqual([]);
  });

  it('저장하면 그 값을 읽는다 (upsert)', async () => {
    await repo.saveAccount(a1, {
      weights: { BLOCKER: 30, ERROR: 10, WARNING: 4, UNVERIFIED: 3 },
      r07SpanHours: 8,
      r07MealMinutes: 45,
      r04Threshold: 5,
      watchKeywords: ['강릉'],
    });
    // 두 번째 저장이 첫 행을 덮는다 (계정당 1행)
    await repo.saveAccount(a1, {
      weights: { BLOCKER: 20, ERROR: 8, WARNING: 3, UNVERIFIED: 2 },
      r07SpanHours: 7,
      r07MealMinutes: 50,
      r04Threshold: 4,
      watchKeywords: ['강릉', '벚꽃'],
    });
    const s = await repo.accountSettings(a1);
    expect(s.r07SpanHours).toBe(7);
    expect(s.r04Threshold).toBe(4);
    expect(s.watchKeywords).toEqual(['강릉', '벚꽃']);
    expect(s.weights.BLOCKER).toBe(20);
  });

  it('계정 설정은 서로 격리된다 (PM-DA-005)', async () => {
    // a1 만 저장했다. a2 는 자기 기본값이어야 한다 — a1 의 값이 새지 않는다.
    const s2 = await repo.accountSettings(a2);
    expect(s2.r07SpanHours).toBe(ACCOUNT_SETTING_DEFAULTS.r07SpanHours);
    expect(s2.r04Threshold).toBe(ACCOUNT_SETTING_DEFAULTS.r04Threshold);
    expect(s2.watchKeywords).toEqual([]);
  });
});
