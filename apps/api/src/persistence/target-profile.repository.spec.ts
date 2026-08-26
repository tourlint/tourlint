import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONCEPT_KEY, TARGET_KEY, TARGET_PROFILE_SEED } from '@tourlint/shared';
import { AccountRepository } from '../auth/account.repository';
import { TargetProfileRepository } from './target-profile.repository';

const URL = process.env.TEST_DATABASE_URL;

if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

describe.skipIf(URL === undefined)('TargetProfileRepository — 실 DB', () => {
  let pool: Pool;
  let repo: TargetProfileRepository;
  let accountId: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL });
    repo = new TargetProfileRepository(pool);
    // 회원가입 트랜잭션이 프로파일까지 만드는지 함께 본다 (DR-CF-002)
    const account = await new AccountRepository(pool).create(`r10-${Date.now()}@t.test`, 'hash');
    accountId = account.id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM account WHERE id = $1`, [accountId]);
    await pool.end();
  });

  it('🔴 계정을 만들면 프로파일 63행이 함께 생긴다 (DR-CF-002)', async () => {
    // 한 조합이라도 비면 그 상품이 R10 을 영영 확인 불가로 남긴다
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM target_profile WHERE account_id = $1`, [accountId],
    );
    expect(Number(rows[0]?.n)).toBe(TARGET_KEY.length * CONCEPT_KEY.length);
    expect(Number(rows[0]?.n)).toBe(TARGET_PROFILE_SEED.length);
  });

  it('시드 값 그대로 들어간다 — 배열과 야간 플래그', async () => {
    const seed = TARGET_PROFILE_SEED.find((p) => p.targetKey === 'YOUTH_20S' && p.conceptKey === 'EMOTIONAL');
    const found = await repo.find(accountId, 'YOUTH_20S', 'EMOTIONAL');
    expect(found?.expectedLcls2).toEqual(seed?.expectedLcls2);
    expect(found?.expectsNight).toBe(seed?.expectsNight);
  });

  it('야간을 기대하지 않는 조합도 그대로다', async () => {
    const found = await repo.find(accountId, 'SENIOR', 'HEALING');
    expect(found?.expectsNight).toBe(false);
    expect(found?.expectedLcls2.length).toBe(3);
  });

  it('🔴 없는 조합은 null 이다 — 비슷한 것으로 대신 주지 않는다', async () => {
    expect(await repo.find(accountId, 'YOUTH_20S', 'NOT_A_CONCEPT')).toBeNull();
    expect(await repo.find(accountId, 'NOT_A_TARGET', 'EMOTIONAL')).toBeNull();
  });

  it('다른 계정의 프로파일을 주지 않는다', async () => {
    expect(await repo.find(accountId + 1_000_000, 'YOUTH_20S', 'EMOTIONAL')).toBeNull();
  });

  it('같은 계정에 같은 조합을 두 번 넣을 수 없다 (uq_profile)', async () => {
    await expect(pool.query(
      `INSERT INTO target_profile (account_id, target_key, concept_key, expected_lcls2, expects_night)
       VALUES ($1, 'YOUTH_20S', 'EMOTIONAL', ARRAY['FD05'], false)`,
      [accountId],
    )).rejects.toThrow();
  });
});
