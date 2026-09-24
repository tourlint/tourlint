import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KOR_BASE_DAILY_QUOTA, KOR_QUOTA_RAISED_UNTIL, SYSTEM_SETTING_DEFAULTS } from '@tourlint/shared';
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

  it('🔴 to_jsonb 는 DATE 를 YYYY-MM-DD 문자열로 준다 — 설정 조회가 기대는 모양이다 (#789)', async () => {
    const { rows } = await pool.query<{ d: unknown }>(`SELECT to_jsonb(DATE '2026-11-05') AS d`);
    expect(rows[0]?.d).toBe('2026-11-05');
  });

  /*
   * 국문 증설 마지막 날을 실제 스키마로 본다 (#789). 전역 행은 세션끼리 같이 쓰므로 바꾸는 것은
   * 전부 한 트랜잭션 안에서 하고 되돌린다 — DDL 도 Postgres 에서는 ROLLBACK 된다.
   */
  describe('국문 증설 마지막 날 — 실 DB · 트랜잭션 안에서 보고 되돌린다 (#789)', () => {
    const kst = (day: string, hhmm = '00:00'): Date => new Date(`${day}T${hhmm}:00+09:00`);
    async function inTx(fn: (r: BatchStateRepository, q: (sql: string) => Promise<unknown>) => Promise<void>): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO system_setting (key) VALUES ('global') ON CONFLICT (key) DO NOTHING`);
        await fn(new BatchStateRepository(client as unknown as Pool), (sql) => client.query(sql));
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }

    it('🔴 칸이 있으면 그 날을 따른다 — 연장이 배포 없이 반영된다', async () => {
      await inTx(async (r, q) => {
        await q(`ALTER TABLE system_setting ADD COLUMN IF NOT EXISTS kor_quota_raised_until DATE NOT NULL DEFAULT DATE '2026-10-11'`);
        await q(`UPDATE system_setting SET daily_quota = 8000, kor_quota_raised_until = DATE '2026-11-05' WHERE key = 'global'`);
        expect((await r.setting(kst('2026-10-12'))).dailyQuota).toBe(8000);
        expect((await r.setting(kst('2026-11-06'))).dailyQuota).toBe(KOR_BASE_DAILY_QUOTA);
      });
    });

    it('🔴 칸이 없는 DB(마이그레이션 전)에서도 조회가 깨지지 않고 10-11 을 쓴다', async () => {
      await inTx(async (r, q) => {
        await q(`ALTER TABLE system_setting DROP COLUMN IF EXISTS kor_quota_raised_until`);
        await q(`UPDATE system_setting SET daily_quota = 8000 WHERE key = 'global'`);
        expect((await r.setting(kst('2026-10-11', '23:59'))).dailyQuota).toBe(8000);
        expect((await r.setting(kst('2026-10-12'))).dailyQuota).toBe(KOR_BASE_DAILY_QUOTA);
      });
    });
  });

  it('전역 설정은 행이 없으면 기본값이다', async () => {
    const setting = await repo.setting();
    expect(setting.batchTime).toMatch(/^\d{2}:\d{2}$/);
    expect(setting.dailyQuota).toBeGreaterThan(0);
    // 배치는 기본이 꺼짐이다 — 켜는 것은 운영 판단이다
    if (setting.batchEnabled === false) expect(SYSTEM_SETTING_DEFAULTS.batchEnabled).toBe(false);
  });
});

/*
 * 그 날의 국문 예산 (#777 · #789). 로컬 테스트 DB 의 전역 행은 세션끼리 같이 쓰고 값이 800 이라
 * 거기서 보면 고치기 전에도 통과한다. 저장값 8,000 을 주는 가짜 연결로 본다.
 * 조회는 `to_jsonb(s) AS row` 라 가짜 연결도 `{ row }` 를 돌려준다.
 */
describe('BatchStateRepository.setting — 국문 증설 종료 (#777 · #789)', () => {
  const repoWith = (rows: readonly Record<string, unknown>[]): BatchStateRepository =>
    new BatchStateRepository({ query: async () => ({ rows: rows.map((row) => ({ row })) }) } as unknown as Pool);
  const stored = { batch_time: '05:00:00', batch_enabled: true, daily_quota: 8000 };
  // KST 자정 = 전날 15:00 UTC
  const kst = (day: string, hhmm = '00:00'): Date => new Date(new Date(`${day}T${hhmm}:00+09:00`).getTime());

  it('🔴 마지막 날 칸이 없으면(마이그레이션 전) 기본값 10-11 로 읽는다 — 다음 날 자정부터 800', async () => {
    expect((await repoWith([stored]).setting(kst('2026-10-11', '23:59'))).dailyQuota).toBe(8000);
    expect((await repoWith([stored]).setting(kst('2026-10-12'))).dailyQuota).toBe(KOR_BASE_DAILY_QUOTA);
  });

  it('🔴 DB 의 마지막 날을 따른다 — 연장하면 그 날까지 8,000 이다 (#789)', async () => {
    const extended = [{ ...stored, kor_quota_raised_until: '2026-11-05' }];
    expect((await repoWith(extended).setting(kst('2026-10-12'))).dailyQuota).toBe(8000);
    expect((await repoWith(extended).setting(kst('2026-11-05', '23:59'))).dailyQuota).toBe(8000);
    expect((await repoWith(extended).setting(kst('2026-11-06'))).dailyQuota).toBe(KOR_BASE_DAILY_QUOTA);
  });

  it('🔴 행이 없어 기본값(8,000)을 쓸 때도 같다', async () => {
    expect(SYSTEM_SETTING_DEFAULTS.dailyQuota).toBeGreaterThan(KOR_BASE_DAILY_QUOTA);
    expect((await repoWith([]).setting(kst('2026-10-12'))).dailyQuota).toBe(KOR_BASE_DAILY_QUOTA);
  });

  it('배치 시각 · 켜짐은 종전처럼 읽는다', async () => {
    expect(await repoWith([stored]).setting(kst('2026-09-25'))).toEqual({ batchTime: '05:00', batchEnabled: true, dailyQuota: 8000 });
  });
});

/*
 * 마지막 날 기본값은 세 곳에 있다 — 스키마 · 마이그레이션 · 코드 상수(칸이 없는 DB 용).
 * 하나만 바뀌면 새 DB 와 기존 DB 와 마이그레이션 전 DB 가 서로 다른 날에 800 으로 내려간다.
 */
describe('국문 증설 마지막 날 기본값이 세 곳에서 같다 (#789)', () => {
  const root = join(__dirname, '../../../..');
  const defaultIn = (file: string): string | undefined =>
    /kor_quota_raised_until\s+DATE\s+NOT NULL\s+DEFAULT\s+DATE\s+'(\d{4}-\d{2}-\d{2})'/.exec(readFileSync(join(root, file), 'utf8'))?.[1];

  it('🔴 schema.sql · 마이그레이션 · KOR_QUOTA_RAISED_UNTIL', () => {
    expect(defaultIn('db/schema.sql')).toBe(KOR_QUOTA_RAISED_UNTIL);
    expect(defaultIn('db/migrations/2026-09-25_kor_quota_raised_until.sql')).toBe(KOR_QUOTA_RAISED_UNTIL);
  });
});
