import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SYSTEM_SETTING_DEFAULTS } from '@tourlint/shared';
import { BATCH_KEY, BatchStateRepository } from './batch-state.repository';

const URL = process.env.TEST_DATABASE_URL;

if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

describe.skipIf(URL === undefined)('BatchStateRepository — 실 DB', () => {
  let pool: Pool;
  let repo: BatchStateRepository;
  const KEY = `sync-test-${Date.now()}`;

  beforeAll(() => {
    pool = new Pool({ connectionString: URL });
    repo = new BatchStateRepository(pool);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM batch_state WHERE key = $1`, [KEY]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM batch_state WHERE key = $1`, [KEY]);
  });

  it('🔴 기본 키가 스키마가 심어 둔 행과 같다', async () => {
    /*
     * `db/schema.sql` 이 `batch_state` 에 1행을 심는다. 상수가 그 키와 어긋나면 배치는
     * 매번 「한 번도 안 돈」 상태로 시작해 어제 하루만 보고, 심어 둔 행은 영영 NULL 로
     * 남는다. 오류가 안 나서 눈에 안 띈다 — 실제로 `sync` 로 어긋나 있었다.
     */
    const { rows } = await pool.query<{ key: string }>(
      `SELECT key FROM batch_state WHERE key NOT LIKE 'sync-test-%'`,
    );
    expect(rows.map((r) => r.key)).toEqual([BATCH_KEY]);
  });

  it('한 번도 안 돈 상태는 전부 null 이다', async () => {
    expect(await repo.find(KEY)).toEqual({
      lastCovered: null, lastRunAt: null, lastStatus: null, lastItemCount: null,
    });
  });

  it('성공하면 기준일이 올라간다 (FR-MO-014)', async () => {
    await repo.record({ key: KEY, status: 'OK', itemCount: 177, ranAt: new Date(), lastCovered: '2026-08-26' });
    const state = await repo.find(KEY);
    expect(state.lastCovered).toBe('2026-08-26');
    expect(state.lastStatus).toBe('OK');
    expect(state.lastItemCount).toBe(177);
  });

  it('🔴 0건 · 실패는 기준일을 건드리지 않는다 (DR-CF-005)', async () => {
    /*
     * 실패에도 갱신하면 그 날짜의 변경을 영영 못 본다 — 다음 배치가 그 다음 날부터
     * 보기 때문이다.
     */
    await repo.record({ key: KEY, status: 'OK', itemCount: 5, ranAt: new Date(), lastCovered: '2026-08-24' });
    await repo.record({ key: KEY, status: 'EMPTY', itemCount: 0, ranAt: new Date() });
    expect((await repo.find(KEY)).lastCovered).toBe('2026-08-24');

    await repo.record({ key: KEY, status: 'FAILED', itemCount: 0, ranAt: new Date() });
    const state = await repo.find(KEY);
    expect(state.lastCovered).toBe('2026-08-24');
    // 상태와 시각은 갱신된다 — 실행했다는 사실은 남아야 한다
    expect(state.lastStatus).toBe('FAILED');
  });

  it('🔴 기준일이 한국 시간 기준으로 읽힌다', async () => {
    // UTC 로 읽으면 하루 밀린다
    await repo.record({ key: KEY, status: 'OK', itemCount: 1, ranAt: new Date(), lastCovered: '2026-01-01' });
    expect((await repo.find(KEY)).lastCovered).toBe('2026-01-01');
  });

  it('배치 상태값은 넷뿐이다 (ck_batch_status)', async () => {
    await expect(pool.query(
      `INSERT INTO batch_state (key, last_status) VALUES ($1, 'WEIRD')`, [`${KEY}-bad`],
    )).rejects.toThrow(/ck_batch_status/);
  });

  it('전역 설정은 행이 없으면 기본값이다', async () => {
    const setting = await repo.setting();
    expect(setting.batchTime).toMatch(/^\d{2}:\d{2}$/);
    expect(setting.dailyQuota).toBeGreaterThan(0);
    // 배치는 기본이 꺼짐이다 — 켜는 것은 운영 판단이다
    if (setting.batchEnabled === false) expect(SYSTEM_SETTING_DEFAULTS.batchEnabled).toBe(false);
  });
});
