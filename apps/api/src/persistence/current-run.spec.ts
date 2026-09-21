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
    expect(await currentRunOf(pool, productId)).toEqual({ kind: 'STALE', runId: null, latestRunId: before, reason: 'PATCH' });
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

  describe('검수한 뒤에 사람이 일정을 고쳤는가 (#710 · PM-NG-002)', () => {
    /** 검수가 저장된 시각을 과거로 둔 실행. 항목 시각(DB now)과 견줄 수 있게 created_at 을 직접 준다 */
    const savedRun = async (ago: string, blockers = 0): Promise<number> => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO audit_run (product_id, executed_at, created_at, ruleset_version, readiness_score, target_count, blocker_cnt, weight_snapshot)
         VALUES ($1, now() - $2::interval, now() - $2::interval, '1.2.4', $3, 3, $4, '{}'::jsonb) RETURNING id`,
        [productId, ago, blockers > 0 ? 75 : 100, blockers],
      );
      return Number(rows[0]?.id);
    };
    const item = async (ago: string, label = '가람집옹심이'): Promise<number> => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO itinerary_item
           (product_id, day_no, seq, start_time, end_time, end_time_source, place_label, item_type, match_status, created_at, updated_at)
         VALUES ($1, 1, (SELECT COALESCE(max(seq), 0) + 1 FROM itinerary_item WHERE product_id = $1),
                 '12:00', '13:00', 'INPUT', $3, 'MEAL', 'EXCLUDED', now() - $2::interval, now() - $2::interval)
         RETURNING id`,
        [productId, ago, label],
      );
      return Number(rows[0]?.id);
    };

    it('검수 전에 만든 일정 그대로면 가장 최근 실행이다', async () => {
      await item('2 hours');
      const audited = await savedRun('1 hour');
      expect(await currentRunOf(pool, productId)).toEqual({ kind: 'LATEST', runId: audited, latestRunId: audited });
    });

    it('🔴 검수 뒤에 항목을 고치면 대응하는 실행이 없다 — 까닭은 EDIT', async () => {
      const itemId = await item('2 hours');
      const audited = await savedRun('1 hour');
      const repo = new ProductRepository(pool);
      // 식사를 새벽 03:00 으로 — 2026-09-21 운영에서 이 상태로 출시가 통과했다
      await repo.patchItem(accountId, itemId, { startTime: '03:00', endTime: '04:00' });

      expect(await currentRunOf(pool, productId)).toEqual({ kind: 'STALE', runId: null, latestRunId: audited, reason: 'EDIT' });
      expect(await repo.releaseBasis(accountId, productId)).toMatchObject({ current: { kind: 'STALE', reason: 'EDIT' } });
      const { rows } = await repo.list(accountId, 0, 20);
      expect(rows[0]?.latestAudit).toMatchObject({ auditRunId: audited, releasable: false });
    });

    it('🔴 검수 뒤에 항목을 더해도, 지워도 마찬가지다 — 지운 줄은 흔적이 없어 남은 줄이 말한다', async () => {
      const repo = new ProductRepository(pool);
      const keep = await item('2 hours', '경포대');
      const gone = await item('2 hours', '가람집옹심이');
      await savedRun('1 hour');
      await repo.deleteItem(accountId, gone);
      expect(await currentRunOf(pool, productId)).toMatchObject({ kind: 'STALE', reason: 'EDIT' });

      // 다시 검수하면 그 실행이 지금 일정의 것이다
      const again = await savedRun('0 seconds');
      await pool.query(`UPDATE itinerary_item SET updated_at = now() - interval '1 minute' WHERE id = $1`, [keep]);
      expect(await currentRunOf(pool, productId)).toMatchObject({ kind: 'LATEST', runId: again });

      await item('0 seconds', '새로 담은 곳');
      // 방금 저장한 검수와 5초 안쪽이라 아직 같은 일정으로 본다 — 시계 차이 여유
      expect(await currentRunOf(pool, productId)).toMatchObject({ kind: 'LATEST', runId: again });
    });

    it('🔴 순서만 바꿔도 고친 것이다 · 같은 순서를 다시 보내는 것은 고친 것이 아니다', async () => {
      const repo = new ProductRepository(pool);
      const a = await item('2 hours', '경포대');
      const b = await item('2 hours', '오죽헌');
      const audited = await savedRun('1 hour');

      await repo.reorderItems(accountId, productId, [{ itemId: a, dayNo: 1, seq: 1 }, { itemId: b, dayNo: 1, seq: 2 }]);
      expect(await currentRunOf(pool, productId)).toMatchObject({ kind: 'LATEST', runId: audited });

      await repo.reorderItems(accountId, productId, [{ itemId: b, dayNo: 1, seq: 1 }, { itemId: a, dayNo: 1, seq: 2 }]);
      expect(await currentRunOf(pool, productId)).toMatchObject({ kind: 'STALE', reason: 'EDIT' });
    });

    it('🔴 출발일을 바꾸면 고친 것이다 · 이름만 바꾸는 것은 아니다', async () => {
      const repo = new ProductRepository(pool);
      await item('2 hours');
      const audited = await savedRun('1 hour');

      await repo.updateBasic(accountId, productId, { name: '강릉 늦가을 1박 2일' });
      expect(await currentRunOf(pool, productId)).toMatchObject({ kind: 'LATEST', runId: audited });

      // 화요일 휴무인 곳은 출발일이 하루만 밀려도 판정이 달라진다
      await repo.updateBasic(accountId, productId, { startDate: '2026-10-23' });
      expect(await currentRunOf(pool, productId)).toMatchObject({ kind: 'STALE', reason: 'EDIT' });
    });

    it('🔴 되돌리기가 다시 쓴 항목은 고친 것이 아니다 — 반영 전 실행이 그대로 현재 결과다', async () => {
      const itemId = await item('3 hours');
      const before = await savedRun('2 hours', 1);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO patch_application
           (product_id, applied_at, applied_by, selected_patches, before_snapshot, after_snapshot, before_audit_run_id)
         VALUES ($1, now() - interval '90 minutes', $2, '[{"findingId":1,"patchId":"p-1"}]'::jsonb, '{}'::jsonb, '{}'::jsonb, $3) RETURNING id`,
        [productId, accountId, before],
      );
      const after = await savedRun('80 minutes', 0);
      // 되돌리기 — 항목을 다시 쓴 시각과 되돌린 시각이 같은 순간이다
      await pool.query(`UPDATE itinerary_item SET updated_at = now() - interval '30 minutes' WHERE id = $1`, [itemId]);
      await pool.query(`UPDATE patch_application SET reverted_at = now() - interval '30 minutes' WHERE id = $1`, [rows[0]?.id]);
      expect(await currentRunOf(pool, productId)).toEqual({ kind: 'RESTORED', runId: before, latestRunId: after });

      // 되돌린 뒤에 사람이 또 고치면 그때는 고친 것이다
      await new ProductRepository(pool).patchItem(accountId, itemId, { startTime: '14:00' });
      expect(await currentRunOf(pool, productId)).toMatchObject({ kind: 'STALE', reason: 'EDIT' });
    });
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
