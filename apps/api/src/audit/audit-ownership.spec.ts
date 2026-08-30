import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditService } from './audit.service';
import { DomainException } from '../common/domain.exception';

/**
 * 소유권 인가 (PM-DA-001 ~ 004 · EX-SY-003).
 *
 * `AuditController` 가 `productId` · `runId` · `jobId` · `findingId` ·
 * `patchApplicationId` 를 계정 대조 없이 받고 있었다. 로그인만 하면 남의 검수 결과를
 * 보고 무시 처리까지 할 수 있었다.
 *
 * PM-DA-002 의 인수조건이 "계정 A가 계정 B의 `audit_run` ID로 검수 결과를 조회하면
 * 거부된다" 이므로 그 문장을 그대로 시험한다.
 */

const URL = process.env.TEST_DATABASE_URL;
let counter = 0;
if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

describe.skipIf(URL === undefined)('검수 소유권 인가', () => {
  let pool: Pool;
  let service: AuditService;
  let mine: number;
  let theirs: number;
  let productId: number;
  let runId: number;
  let jobId: number;
  let findingId: number;

  beforeAll(() => {
    pool = new Pool({ connectionString: URL, max: 4 });
    service = new AuditService(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    const accounts = await pool.query<{ id: string }>(
      `INSERT INTO account (email, password_hash) VALUES ($1,'x'), ($2,'x') RETURNING id`,
      [`own-${String(process.pid)}-${String(counter++)}@example.com`,
       `own-${String(process.pid)}-${String(counter++)}@example.com`],
    );
    mine = Number(accounts.rows[0]?.id);
    theirs = Number(accounts.rows[1]?.id);

    const prod = await pool.query<{ id: string }>(
      `INSERT INTO product (account_id, name, ldong_regn_cd, start_date, nights, transport)
       VALUES ($1,'강릉 1박 2일','51', DATE '2026-10-13', 1, 'CAR') RETURNING id`,
      [mine],
    );
    productId = Number(prod.rows[0]?.id);

    const run = await pool.query<{ id: string }>(
      `INSERT INTO audit_run
         (product_id, executed_at, ruleset_version, readiness_score, target_count,
          failed_count, weight_snapshot)
       VALUES ($1, now(), 'r1', 90, 1, 0,
               '{"BLOCKER":25,"ERROR":10,"WARNING":4,"UNVERIFIED":3}'::jsonb) RETURNING id`,
      [productId],
    );
    runId = Number(run.rows[0]?.id);

    const job = await pool.query<{ id: string }>(
      `INSERT INTO audit_job (product_id, status, trigger_type, audit_run_id)
       VALUES ($1,'DONE','MANUAL',$2) RETURNING id`,
      [productId, runId],
    );
    jobId = Number(job.rows[0]?.id);

    const finding = await pool.query<{ id: string }>(
      `INSERT INTO finding
         (audit_run_id, rule_code, rule_version, severity, reason_code, message, evidence)
       VALUES ($1,'R01','1','WARNING','CLOSED_ON_VISIT','메시지','{}'::jsonb) RETURNING id`,
      [runId],
    );
    findingId = Number(finding.rows[0]?.id);
  });

  afterEach(async () => {
    await pool.query(
      'DELETE FROM patch_application WHERE product_id IN (SELECT id FROM product WHERE account_id = ANY($1::bigint[]))',
      [[mine, theirs]],
    );
    await pool.query('DELETE FROM account WHERE id = ANY($1::bigint[])', [[mine, theirs]]);
  });

  const is404 = (e: unknown): boolean =>
    e instanceof DomainException && e.getStatus() === 404 && e.reasonCode === 'NOT_FOUND';

  it('🔴 계정 A 가 계정 B 의 audit_run ID 로 조회하면 거부된다 (PM-DA-002 인수조건)', async () => {
    await expect(service.assertOwns('run', runId, theirs)).rejects.toSatisfy(is404);
    await expect(service.assertOwns('run', runId, mine)).resolves.toBeUndefined();
  });

  it('🔴 상품 · 작업 · 발견 항목도 계정을 대조한다', async () => {
    for (const [kind, id] of [
      ['product', productId], ['job', jobId], ['finding', findingId],
    ] as const) {
      await expect(service.assertOwns(kind, id, theirs), kind).rejects.toSatisfy(is404);
      await expect(service.assertOwns(kind, id, mine), kind).resolves.toBeUndefined();
    }
  });

  it('🔴 403 이 아니라 404 다 — 403 은 그 자체가 존재한다는 답이다 (PM-DA-003)', async () => {
    await expect(service.assertOwns('run', runId, theirs)).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainException && e.getStatus() !== 403,
    );
  });

  it('없는 id 와 남의 id 가 같은 응답이다 — 구분되면 존재 여부가 새어 나간다', async () => {
    const missing = service.assertOwns('run', 999_999_999, mine).catch((e: unknown) => e);
    const foreign = service.assertOwns('run', runId, theirs).catch((e: unknown) => e);
    const [a, b] = await Promise.all([missing, foreign]);
    expect((a as DomainException).getStatus()).toBe((b as DomainException).getStatus());
    expect((a as DomainException).reasonCode).toBe((b as DomainException).reasonCode);
  });

  it('🔴 id 를 받는 라우트에 계정 대조가 빠진 곳이 없다', () => {
    /*
     * 라우트가 늘어날 때 계정 대조를 빠뜨리는 것을 잡는다. 동작 검사만으로는 **새로
     * 추가된** 라우트를 못 잡는다 — 테스트를 같이 안 쓰면 그만이기 때문이다.
     *
     * `:id` 를 경로에 가진 메서드는 전부 `assertOwns` 를 불러야 한다.
     */
    const src = readFileSync(join(__dirname, 'audit.controller.ts'), 'utf8');
    const methods = src.split(/\n {2}@(?:Get|Post|Delete|Put|Patch)\(/).slice(1);
    const missing: string[] = [];
    for (const m of methods) {
      const path = m.slice(0, m.indexOf(')'));
      if (!/:\w*[Ii]d/.test(path)) continue;
      const body = m.slice(0, m.indexOf('\n' + ' '.repeat(2) + '}'));
      if (!body.includes('assertOwns')) missing.push(path);
    }
    expect(missing).toEqual([]);
  });
});
