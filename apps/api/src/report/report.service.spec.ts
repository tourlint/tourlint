import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CatalogService } from '../catalog/catalog.service';
import { DomainException } from '../common/domain.exception';
import { InMemoryApiCallLogger } from '../external/api-call-log';
import { createKtoClient } from '../external/kto';
import { WalkNameResolver } from '../plan/walk-names';
import { ReportService } from './report.service';
import type { ReportModel } from './report-model';

/**
 * 리포트 관통 — **실 DB + 픽스처 리플레이**.
 *
 * 소유권과 "최신 실행만" 두 가지가 여기서만 확인된다. 나머지(모델 · 렌더 · 원문 조회)는
 * DB 없이 도는 스펙이 따로 있다.
 */

const URL = process.env.TEST_DATABASE_URL;
let counter = 0;
if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

const FIXTURE_ENV = {
  KTO_MODE: 'fixture',
  KTO_FIXTURE_DIR: join(__dirname, '../../../../fixtures/kto'),
};

describe.skipIf(URL === undefined)('ReportService — 관통', () => {
  let pool: Pool;
  let service: ReportService;
  let accountId: number;
  let otherAccountId: number;
  let productId: number;
  let runId: number;

  beforeAll(() => {
    process.env.KTO_MODE = 'fixture';
    process.env.KTO_FIXTURE_DIR = FIXTURE_ENV.KTO_FIXTURE_DIR;
    pool = new Pool({ connectionString: URL, max: 4 });
    const catalog = new CatalogService(
      () => createKtoClient(new InMemoryApiCallLogger(), FIXTURE_ENV),
    );
    const walkNames = new WalkNameResolver({
      kto: () => createKtoClient(new InMemoryApiCallLogger(), FIXTURE_ENV),
      budget: async () => ({ allowed: true, ratio: 0, reasonCode: null, warn: false, remaining: 800 }),
    });
    service = new ReportService(pool, catalog, walkNames);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    const emails = [
      `rpt-${String(process.pid)}-${String(counter++)}@example.com`,
      `rpt-${String(process.pid)}-${String(counter++)}@example.com`,
    ];
    const accounts = await pool.query<{ id: string }>(
      `INSERT INTO account (email, password_hash)
       VALUES ($1,'x'), ($2,'x') RETURNING id`,
      emails,
    );
    accountId = Number(accounts.rows[0]?.id);
    otherAccountId = Number(accounts.rows[1]?.id);

    const prod = await pool.query<{ id: string }>(
      `INSERT INTO product (account_id, name, ldong_regn_cd, start_date, nights, transport)
       VALUES ($1,'강릉 1박 2일','51', DATE '2026-10-13', 1, 'CAR') RETURNING id`,
      [accountId],
    );
    productId = Number(prod.rows[0]?.id);

    await pool.query(
      `INSERT INTO itinerary_item
         (product_id, day_no, seq, start_time, end_time, end_time_source, place_label,
          item_type, kto_content_id, content_type_id, match_status)
       VALUES ($1,1,1,'10:00'::time,'11:00'::time,'INPUT','오죽헌','SIGHT','126508',12,'CONFIRMED'),
              ($1,1,2,'12:00'::time,'13:00'::time,'INPUT','동네 카페','MEAL',NULL,NULL,'EXCLUDED')`,
      [productId],
    );
    runId = await insertRun(pool, productId);
  });

  afterEach(async () => {
    // 반영 이력의 applied_by 가 계정을 CASCADE 없이 가리킨다. 상품을 먼저 지운다
    await pool.query('DELETE FROM product WHERE account_id = ANY($1::bigint[])',
      [[accountId, otherAccountId]]);
    await pool.query('DELETE FROM account WHERE id = ANY($1::bigint[])',
      [[accountId, otherAccountId]]);
  });

  it('소유자는 리포트를 만들고 내려받는다', async () => {
    const { reportId } = await service.create(runId, accountId);
    const file = service.download(reportId, accountId);
    expect(file.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(file.fileName).toContain('.pdf');
  });

  it('🔴 남의 검수 실행으로는 만들 수 없다 — 404 로 존재를 숨긴다 (PM-DA-002 · EX-SY-003)', async () => {
    await expect(service.create(runId, otherAccountId)).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainException
        && e.getStatus() === 404 && e.reasonCode === 'NOT_FOUND',
    );
  });

  it('🔴 남의 reportId 로는 내려받을 수 없다 (PM-DA-007)', async () => {
    const { reportId } = await service.create(runId, accountId);
    expect(() => service.download(reportId, otherAccountId)).toThrowError(DomainException);
  });

  it('🔴 최신이 아닌 검수 실행은 거절한다 — 그때 판정과 지금 일정이 섞인다', async () => {
    const older = runId;
    await insertRun(pool, productId);

    await expect(service.create(older, accountId)).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainException
        && e.getStatus() === 409 && e.reasonCode === 'REPORT_FAILED',
    );
  });

  it('🔴 수정안을 되돌린 뒤에는 반영 후 실행으로 만들 수 없고 반영 전 실행으로 만든다 (#551)', async () => {
    /*
     * 되돌리기는 새 실행을 만들지 않는다. 가장 최근 실행만 받던 때는 되돌린 일정에 반영 후
     * 판정을 붙인 리포트가 나왔다. 되돌린 일정의 판정은 반영 전 실행이다.
     */
    const before = runId;
    const applied = await pool.query<{ id: string }>(
      `INSERT INTO patch_application
         (product_id, applied_at, applied_by, selected_patches, before_snapshot, after_snapshot, before_audit_run_id)
       VALUES ($1, clock_timestamp(), $2, '[{"findingId":1,"patchId":"p-1"}]'::jsonb, $4::jsonb, $4::jsonb, $3)
       RETURNING id`,
      [productId, accountId, before, JSON.stringify({ snapshotVersion: '1', snapshotAt: '2026-09-20T01:00:00Z', productId, items: [] })],
    );
    const after = await insertRun(pool, productId);
    await pool.query(`UPDATE patch_application SET reverted_at = clock_timestamp() WHERE id = $1`, [applied.rows[0]?.id]);

    await expect(service.create(after, accountId)).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainException
        && e.getStatus() === 409 && e.reasonCode === 'REPORT_FAILED',
    );
    await expect(service.create(before, accountId)).resolves.toHaveProperty('reportId');
  });

  it('🔴 되돌리지 않은 가장 최근 반영의 전후 비교를 싣는다 — 되돌리면 싣지 않는다 (FR-PA-043 · #806)', async () => {
    const before = runId;
    const snapshot = JSON.stringify({ snapshotVersion: '1', snapshotAt: '2026-09-25T01:00:00Z', productId, items: [] });
    const applied = await pool.query<{ id: string }>(
      `INSERT INTO patch_application
         (product_id, applied_at, applied_by, selected_patches, before_snapshot, after_snapshot, before_audit_run_id)
       VALUES ($1, clock_timestamp(), $2, '[{"findingId":1,"patchId":"p-1"}]'::jsonb, $4::jsonb, $4::jsonb, $3)
       RETURNING id`,
      [productId, accountId, before, snapshot],
    );
    const applicationId = applied.rows[0]?.id;
    const after = await insertRun(pool, productId);
    const build = (id: number): Promise<ReportModel> =>
      (service as unknown as { buildModel(run: number, product: number): Promise<ReportModel> }).buildModel(id, productId);

    // 재검수가 붙기 전에는 싣지 않는다 — 빈 비교를 만들지 않는다
    expect((await build(after)).comparison).toBeNull();

    await pool.query('UPDATE patch_application SET after_audit_run_id = $2 WHERE id = $1', [applicationId, after]);
    const rows = (await build(after)).comparison?.rows ?? [];
    expect(rows.map((r) => r[0])).toEqual(['차단', '오류', '주의', '확인 불가', '총 감점', '출시 준비도', '수요 적합성']);
    expect(rows.find((r) => r[0] === '오류')).toEqual(['오류', '1', '1', '변화 없음']);

    await pool.query('UPDATE patch_application SET reverted_at = clock_timestamp() WHERE id = $1', [applicationId]);
    expect((await build(before)).comparison).toBeNull();
  });

  it('🔴 1절에 기획 출처 · 줄마다 들어온 경로 · 고른 방식을 한 줄로 싣는다 (FR-PL-020)', async () => {
    await pool.query(`UPDATE product SET plan_origin = '{"startedBy":"TEXT"}'::jsonb WHERE id = $1`, [productId]);
    await pool.query(`UPDATE itinerary_item SET origin = 'TEXT', matched_by = 'AUTO' WHERE product_id = $1 AND seq = 1`, [productId]);
    const model = await (service as unknown as { buildModel(run: number, product: number): Promise<ReportModel> })
      .buildModel(runId, productId);
    // 경로를 남기기 전에 넣은 줄(seq 2)은 직접 입력으로 치지 않는다
    expect(model.product.planning).toBe('메모 붙여넣기로 시작 · 일정 2개 (메모 1 · 기록 없음 1) · 고른 방식 (자동 1)');
  });

  it('검수 제외 항목 건수가 리포트에 반영된다 (FR-PA-064)', async () => {
    // 렌더 결과를 직접 못 읽으므로 모델 경유 확인은 report-model.spec 이 한다.
    // 여기서는 EXCLUDED 항목이 있어도 생성이 끝까지 도는지만 본다
    const { reportId } = await service.create(runId, accountId);
    expect(service.download(reportId, accountId).pdf.length).toBeGreaterThan(1000);
  });

  it('🔴 리포트를 만들어도 DB 에 파일이 남지 않는다 (DB 명세서 6-4)', async () => {
    const before = await tableNames(pool);
    await service.create(runId, accountId);
    const after = await tableNames(pool);
    expect(after).toEqual(before);
    // PDF 를 담을 만한 바이너리 컬럼이 어디에도 없다
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type = 'bytea'`,
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});

async function insertRun(pool: Pool, productId: number): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO audit_run
       (product_id, executed_at, ruleset_version, readiness_score, target_count,
        failed_count, blocker_cnt, error_cnt, warn_cnt, unverified_cnt, weight_snapshot)
     VALUES ($1, now(), 'r1', 90, 1, 0, 0, 1, 0, 0,
             '{"BLOCKER":25,"ERROR":10,"WARNING":4,"UNVERIFIED":3}'::jsonb)
     RETURNING id`,
    [productId],
  );
  const runId = Number(rows[0]?.id);
  await pool.query(
    `INSERT INTO finding
       (audit_run_id, rule_code, rule_version, severity, reason_code, message, evidence)
     VALUES ($1,'R01','1','ERROR','CLOSED_ON_VISIT','방문일이 휴무일입니다.','{}'::jsonb)`,
    [runId],
  );
  await pool.query(
    `INSERT INTO content_fingerprint
       (audit_run_id, kto_content_id, content_type_id, fetched_at, kto_modified_time,
        show_flag, field_names, field_hash, parse_confidence)
     VALUES ($1,'126508',12, now(), '20260801120000', 1,
             ARRAY['restdate','usetime'], $2, 'CONFIRMED')`,
    [runId, 'a'.repeat(64)],
  );
  return runId;
}

async function tableNames(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}
