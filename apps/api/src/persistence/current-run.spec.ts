import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProductRepository } from '../product/product.repository';
import { currentRunOf } from './current-run';

/**
 * 지금 일정에 대응하는 검수 실행 (#551) — 실 DB.
 *
 * 되돌리기 · 반영 시각과 실행 시각을 견주는 SQL 이라 가짜 커넥션으로는 확인할 것이 없다.
 * 실행과 반영 이력은 필요한 칸만 채워 직접 넣는다.
 */

const URL = process.env.TEST_DATABASE_URL;
let counter = 0;

if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

describe.skipIf(URL === undefined)('지금 일정의 검수 실행 (#551)', () => {
  let pool: Pool;
  let accountId: number;
  let productId: number;

  beforeAll(() => {
    pool = new Pool({ connectionString: URL, max: 4 });
  });

  afterAll(async () => {
    await pool.end();
  });

  /*
   * 전역 TRUNCATE 없이 자기 계정만 지운다. 반영 이력의 `applied_by` 가 계정을 CASCADE 없이
   * 가리켜서, 상품(→ 실행 · 반영 이력)을 먼저 지우고 계정을 지운다.
   */
  beforeEach(async () => {
    const account = await pool.query<{ id: string }>(
      `INSERT INTO account (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`current-run-${String(process.pid)}-${String(counter++)}@example.com`],
    );
    accountId = Number(account.rows[0]?.id);
    const product = await pool.query<{ id: string }>(
      `INSERT INTO product (account_id, name, ldong_regn_cd, start_date, nights, transport, planned_at)
       VALUES ($1, '강릉 되돌리기 1박 2일', '51', DATE '2026-10-22', 1, 'CAR', now()) RETURNING id`,
      [accountId],
    );
    productId = Number(product.rows[0]?.id);
  });

  afterEach(async () => {
    await pool.query('DELETE FROM product WHERE account_id = $1', [accountId]);
    await pool.query('DELETE FROM account WHERE id = $1', [accountId]);
  });

  const run = async (at: string, blockers: number): Promise<number> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO audit_run (product_id, executed_at, ruleset_version, readiness_score, target_count, blocker_cnt, weight_snapshot)
       VALUES ($1, $2, '1.2.4', $3, 3, $4, '{}'::jsonb) RETURNING id`,
      [productId, at, blockers > 0 ? 75 : 100, blockers],
    );
    return Number(rows[0]?.id);
  };
  const apply = async (at: string, beforeRunId: number | null): Promise<number> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO patch_application
         (product_id, applied_at, applied_by, selected_patches, before_snapshot, after_snapshot, before_audit_run_id)
       VALUES ($1, $2, $3, '[{"findingId":1,"patchId":"p-1"}]'::jsonb, '{}'::jsonb, '{}'::jsonb, $4) RETURNING id`,
      [productId, at, accountId, beforeRunId],
    );
    return Number(rows[0]?.id);
  };
  const revert = async (applicationId: number, at: string): Promise<void> => {
    await pool.query(`UPDATE patch_application SET reverted_at = $2 WHERE id = $1`, [applicationId, at]);
  };

  it('검수한 적이 없으면 NONE 이다', async () => {
    expect(await currentRunOf(pool, productId)).toEqual({ kind: 'NONE', runId: null, latestRunId: null });
  });

  it('반영 · 되돌리기가 없으면 가장 최근 실행이다', async () => {
    await run('2026-09-20T01:00:00Z', 1);
    const latest = await run('2026-09-20T02:00:00Z', 0);
    expect(await currentRunOf(pool, productId)).toEqual({ kind: 'LATEST', runId: latest, latestRunId: latest });
  });

  it('반영하고 재검수가 끝나면 재검수 실행이다', async () => {
    const before = await run('2026-09-20T01:00:00Z', 1);
    await apply('2026-09-20T01:10:00Z', before);
    const after = await run('2026-09-20T01:10:05Z', 0);
    expect(await currentRunOf(pool, productId)).toMatchObject({ kind: 'LATEST', runId: after });
  });

  it('🔴 되돌리면 반영 전 실행이다 — 반영 후 실행이 더 최근이어도', async () => {
    const before = await run('2026-09-20T01:00:00Z', 1);
    const application = await apply('2026-09-20T01:10:00Z', before);
    const after = await run('2026-09-20T01:10:05Z', 0);
    await revert(application, '2026-09-20T01:20:00Z');

    expect(await currentRunOf(pool, productId)).toEqual({ kind: 'RESTORED', runId: before, latestRunId: after });
  });

  it('🔴 반영하고 재검수 전이면 대응하는 실행이 없다', async () => {
    const before = await run('2026-09-20T01:00:00Z', 0);
    await apply('2026-09-20T01:10:00Z', before);
    expect(await currentRunOf(pool, productId)).toEqual({ kind: 'STALE', runId: null, latestRunId: before });
  });

  it('되돌린 뒤 다시 검수하면 그 실행이다', async () => {
    const before = await run('2026-09-20T01:00:00Z', 1);
    const application = await apply('2026-09-20T01:10:00Z', before);
    await run('2026-09-20T01:10:05Z', 0);
    await revert(application, '2026-09-20T01:20:00Z');
    const again = await run('2026-09-20T01:30:00Z', 1);
    expect(await currentRunOf(pool, productId)).toMatchObject({ kind: 'LATEST', runId: again });
  });

  it('되돌린 뒤 다른 수정안을 반영하면 재검수 전까지는 대응하는 실행이 없다', async () => {
    const before = await run('2026-09-20T01:00:00Z', 1);
    const first = await apply('2026-09-20T01:10:00Z', before);
    await run('2026-09-20T01:10:05Z', 0);
    await revert(first, '2026-09-20T01:20:00Z');
    await apply('2026-09-20T01:25:00Z', before);
    expect(await currentRunOf(pool, productId)).toMatchObject({ kind: 'STALE', runId: null });
  });

  describe('출시 판정 · 상품 목록이 같은 실행을 본다', () => {
    it('🔴 차단을 없앤 수정안을 되돌리면 출시할 수 없다 — 목록도 반영 전 실행을 싣는다', async () => {
      const repo = new ProductRepository(pool);
      const before = await run('2026-09-20T01:00:00Z', 1);
      const application = await apply('2026-09-20T01:10:00Z', before);
      await run('2026-09-20T01:10:05Z', 0);
      await revert(application, '2026-09-20T01:20:00Z');

      expect(await repo.releaseBasis(accountId, productId)).toMatchObject({
        current: { kind: 'RESTORED', runId: before }, currentBlockers: 1, latestBlockers: 0,
      });
      const { rows } = await repo.list(accountId, 0, 20);
      expect(rows[0]?.latestAudit).toMatchObject({ auditRunId: before, counts: { blocker: 1 }, releasable: false });
    });

    it('반영하고 재검수 전이면 목록은 가장 최근 실행을 싣되 출시할 수 없다고 한다', async () => {
      const repo = new ProductRepository(pool);
      const before = await run('2026-09-20T01:00:00Z', 0);
      await apply('2026-09-20T01:10:00Z', before);
      const { rows } = await repo.list(accountId, 0, 20);
      expect(rows[0]?.latestAudit).toMatchObject({ auditRunId: before, releasable: false });
    });

    it('평소에는 가장 최근 실행이고 차단이 없으면 출시할 수 있다', async () => {
      const repo = new ProductRepository(pool);
      await run('2026-09-20T01:00:00Z', 1);
      const latest = await run('2026-09-20T02:00:00Z', 0);
      const { rows } = await repo.list(accountId, 0, 20);
      expect(rows[0]?.latestAudit).toMatchObject({ auditRunId: latest, releasable: true });
      await expect(repo.releaseBasis(accountId, productId)).resolves.toMatchObject({
        current: { kind: 'LATEST', runId: latest }, currentBlockers: 0, latestBlockers: 0,
      });
    });
  });
});
