import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountRepository } from '../auth/account.repository';
import { COMPANY_SETTING_DEFAULTS, SettingsRepository } from './settings.repository';

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

  it('회사 기준을 정한 적 없으면 표준값과 빈 목록을 읽는다', async () => {
    const s = await repo.company(a1);
    expect(s.r07SpanHours).toBe(COMPANY_SETTING_DEFAULTS.r07SpanHours);
    expect(s.r07MealMinutes).toBe(COMPANY_SETTING_DEFAULTS.r07MealMinutes);
    expect(s.updatedAt).toBeNull();
    expect(s.history).toEqual([]);
    expect(s.watchKeywords).toEqual([]);
    expect(s.watchRegions).toEqual([]);
  });

  it('회사 기준을 저장하면 그 값과 변경 이력을 읽는다 (upsert · 엄격하게만)', async () => {
    await repo.saveCompany(a1, { r07SpanHours: 5, watchKeywords: ['강릉'] }, '2026-09-16T01:00:00.000Z');
    // 두 번째 저장이 첫 행을 덮고, 바뀐 R07 값만 이력에 쌓인다 (식사 60 → 90)
    const saved = await repo.saveCompany(
      a1,
      { r07MealMinutes: 90, watchRegions: [{ regnCd: '51', signguCd: '150', month: '2026-10' }] },
      '2026-09-16T02:00:00.000Z',
    );
    expect(saved.r07SpanHours).toBe(5); // 안 준 값은 그대로
    expect(saved.r07MealMinutes).toBe(90);
    expect(saved.watchKeywords).toEqual(['강릉']);
    expect(saved.watchRegions).toEqual([{ regnCd: '51', signguCd: '150', month: '2026-10' }]);

    const read = await repo.company(a1);
    expect(read.r07MealMinutes).toBe(90);
    // 이력: 연속 6→5, 식사 60→90 — 두 줄
    expect(read.history).toEqual([
      { at: '2026-09-16T01:00:00.000Z', field: 'r07SpanHours', from: 6, to: 5 },
      { at: '2026-09-16T02:00:00.000Z', field: 'r07MealMinutes', from: 60, to: 90 },
    ]);
    expect(read.updatedAt).not.toBeNull();
  });

  it('계정 설정은 서로 격리된다 (PM-DA-005)', async () => {
    // a1 만 저장했다. a2 는 표준값이어야 한다 — a1 의 값이 새지 않는다.
    const s2 = await repo.company(a2);
    expect(s2.r07SpanHours).toBe(COMPANY_SETTING_DEFAULTS.r07SpanHours);
    expect(s2.r07MealMinutes).toBe(COMPANY_SETTING_DEFAULTS.r07MealMinutes);
    expect(s2.watchKeywords).toEqual([]);
  });

  it('전역 설정을 저장하고 다시 읽는다 (원복)', async () => {
    // 전역은 계정에 매이지 않는 공유 행이라, 원본을 되돌려 다른 테스트에 새지 않게 한다.
    const before = await repo.global();
    await repo.saveGlobal({ batchTime: '06:30', batchEnabled: true, dailyQuota: 1234 });
    expect(await repo.global()).toEqual({ batchTime: '06:30', batchEnabled: true, dailyQuota: 1234 });
    await repo.saveGlobal(before);
    expect(await repo.global()).toEqual(before);
  });
});
