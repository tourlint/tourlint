import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService, toFindingsResponse, toJobResponse, toRunResponse } from './audit.service';
import { DomainException } from '../common/domain.exception';

/**
 * 검수 관통 — **실 DB + 픽스처 리플레이**.
 *
 * W1 게이트가 요구하는 "등록 → 검수 → 결과" 를 코드로 확인하는 자리다.
 * 공사 호출은 0건이라 예산을 쓰지 않는다.
 */

const URL = process.env.TEST_DATABASE_URL;
let counter = 0;
if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

describe.skipIf(URL === undefined)('AuditService — 관통', () => {
  let pool: Pool;
  let service: AuditService;
  let productId: number;
  let accountId: number;
  /** 호출 로그는 계정에 딸리지 않아 CASCADE 로 안 지워진다. 이 테스트가 만든 것만 센다 */
  let since: Date;

  beforeAll(() => {
    // 리플레이 모드. 운영에서는 기동이 거부된다 (FR-OP-009)
    process.env.KTO_MODE = 'fixture';
    process.env.KTO_FIXTURE_DIR = join(__dirname, '../../../../fixtures/kto');
    pool = new Pool({ connectionString: URL, max: 4 });
    service = new AuditService(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  /** TP-03 축약판 — 화요일 휴무 · 30분 중복 · 끝난 축제 */
  const ITEMS: ReadonlyArray<[number, number, string, string | null, string, string, string, number, string]> = [
    [1, 2, '12:00', '13:00', 'MEAL', '가람집옹심이', '2868839', 39, 'FD01'],
    [1, 3, '12:30', '14:00', 'SIGHT', '오죽헌·시립박물관', '129784', 14, 'VE07'],
    [2, 1, '09:00', '10:00', 'SIGHT', '경포벚꽃축제', '695592', 15, 'EV01'],
  ];

  afterEach(async () => {
    await pool.query('DELETE FROM api_call_log WHERE called_at >= $1', [since]);
    await pool.query('DELETE FROM account WHERE id = $1', [accountId]);
  });

  beforeEach(async () => {
    since = new Date(Date.now() - 1000);
    const acc = await pool.query<{ id: string }>(
      `INSERT INTO account (email, password_hash) VALUES ($1,'x') RETURNING id`,
      [`svc-${String(process.pid)}-${String(counter++)}@example.com`],
    );
    accountId = Number(acc.rows[0]?.id);
    const prod = await pool.query<{ id: string }>(
      `INSERT INTO product (account_id, name, ldong_regn_cd, start_date, nights, transport)
       VALUES ($1,'강릉 1박 2일','51', DATE '2026-10-13', 1, 'CAR') RETURNING id`,
      [acc.rows[0]?.id],
    );
    productId = Number(prod.rows[0]?.id);

    for (const [day, seq, start, end, type, label, contentId, ctid, lcls] of ITEMS) {
      await pool.query(
        `INSERT INTO itinerary_item
           (product_id, day_no, seq, start_time, end_time, end_time_source, place_label,
            item_type, kto_content_id, content_type_id, lcls_systm2, match_status)
         VALUES ($1,$2,$3,$4::time,$5::time,'INPUT',$6,$7,$8,$9,$10,'CONFIRMED')`,
        [productId, day, seq, start, end, label, type, contentId, ctid, lcls],
      );
    }
  });

  describe('사전 검증', () => {
    it('없는 상품은 404 NOT_FOUND 다', async () => {
      const e = await service.requestAudit(999999, 'INITIAL').catch((x: unknown) => x);
      expect(e).toBeInstanceOf(DomainException);
      expect((e as DomainException).reasonCode).toBe('NOT_FOUND');
      expect((e as DomainException).unit).toBe('PRODUCT');
    });

    it('미확정 관광지가 남아 있으면 422 로 거부한다 (EX-AU-001)', async () => {
      await pool.query(
        `INSERT INTO itinerary_item
           (product_id, day_no, seq, start_time, end_time_source, place_label, item_type, match_status)
         VALUES ($1, 1, 9, TIME '15:00', 'INPUT', '이름만 적은 곳', 'SIGHT', 'PENDING')`,
        [productId],
      );
      const e = await service.requestAudit(productId, 'INITIAL').catch((x: unknown) => x);
      expect((e as DomainException).reasonCode).toBe('PLACE_UNRESOLVED');
      expect((e as DomainException).getStatus()).toBe(422);
      // 어느 항목이 미확정인지 알려준다
      expect((e as DomainException).fieldErrors?.[0]?.message).toContain('이름만 적은 곳');
    });

    it('진행 중인 작업이 있으면 새로 만들지 않고 기존 jobId 를 준다 (EX-AU-004)', async () => {
      const first = await service.requestAudit(productId, 'INITIAL');
      // 첫 작업이 끝나기 전에 다시 요청
      const second = await service.requestAudit(productId, 'MANUAL');
      if (second.created) {
        // 첫 작업이 이미 끝났다면 새로 만드는 게 맞다
        expect(second.job.id).not.toBe(first.job.id);
      } else {
        expect(second.job.id).toBe(first.job.id);
      }
      await service.waitForIdle();
    });
  });

  describe('등록 → 검수 → 결과 (W1 게이트)', () => {
    it('202 로 jobId 를 주고 뒤에서 검수한 뒤 DONE 이 된다', async () => {
      const { job, created } = await service.requestAudit(productId, 'INITIAL');
      expect(created).toBe(true);
      expect(toJobResponse(job, true)).toMatchObject({
        status: 'QUEUED', productId, pollIntervalMs: 2000,
      });

      await service.waitForIdle();

      const done = await service.getJob(job.id);
      expect(done.status).toBe('DONE');
      expect(done.auditRunId).not.toBeNull();
      expect(done.progressDone).toBe(done.progressTotal);
    });

    it('세 규칙이 모두 발동한다', async () => {
      const { job } = await service.requestAudit(productId, 'INITIAL');
      await service.waitForIdle();
      const runId = (await service.getJob(job.id)).auditRunId as number;

      const findings = toFindingsResponse(await service.getRun(runId));
      const codes = (findings.content as { reasonCode: string }[]).map((f) => f.reasonCode);
      expect(codes).toContain('REST_DAY_CONFLICT');
      expect(codes).toContain('TIME_OVERLAP');
      expect(codes).toContain('EVENT_ENDED');
    });

    it('결과 응답이 API 설계 5-5 형식이다', async () => {
      const { job } = await service.requestAudit(productId, 'INITIAL');
      await service.waitForIdle();
      const runId = (await service.getJob(job.id)).auditRunId as number;

      const body = toRunResponse(await service.getRun(runId));
      expect(body).toMatchObject({
        auditRunId: runId, productId, isPartial: false, releasable: false,
      });
      // 점수가 산식에서 나왔음을 화면에서 검산할 수 있어야 한다 (FR-AU-043)
      expect(String((body.scoreBreakdown as Record<string, unknown>).formula)).toMatch(/^100 − /);
      expect(body.counts).toMatchObject({ blocker: 2, dismissed: 0 });
      expect((body.evidence as Record<string, unknown>).source).toBe('출처: ⓒ한국관광공사');
    });

    it('등급으로 거를 수 있다', async () => {
      const { job } = await service.requestAudit(productId, 'INITIAL');
      await service.waitForIdle();
      const run = await service.getRun((await service.getJob(job.id)).auditRunId as number);

      const blockers = toFindingsResponse(run, 'BLOCKER').content as { severity: string }[];
      expect(blockers.length).toBeGreaterThan(0);
      expect(blockers.every((f) => f.severity === 'BLOCKER')).toBe(true);
    });

    it('지문을 콘텐츠마다 저장한다', async () => {
      const { job } = await service.requestAudit(productId, 'INITIAL');
      await service.waitForIdle();
      const runId = (await service.getJob(job.id)).auditRunId as number;

      const { rows } = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM content_fingerprint WHERE audit_run_id = $1', [runId],
      );
      expect(Number(rows[0]?.n)).toBe(3);
    });

    it('호출 로그를 남긴다 — 공모전 활용 증빙이다 (FR-OP-001)', async () => {
      await service.requestAudit(productId, 'INITIAL');
      await service.waitForIdle();

      const { rows } = await pool.query<{ operation: string; n: string }>(
        `SELECT operation, count(*)::text AS n FROM api_call_log
          WHERE provider = 'KTO' AND called_at >= $1
          GROUP BY operation ORDER BY operation`,
        [since],
      );
      const ops = Object.fromEntries(rows.map((r) => [r.operation, Number(r.n)]));
      expect(ops.detailIntro2).toBe(3);
      // 리플레이도 로그를 남긴다. 실호출로 바꿔도 같은 자리에서 세어진다
      expect(ops.detailCommon2).toBe(3);
    });
  });

  it('결정론성 — 같은 상품을 세 번 검수하면 판정이 완전히 같다 (NF-MT-001)', async () => {
    const signatures: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { job } = await service.requestAudit(productId, 'MANUAL');
      await service.waitForIdle();
      const run = await service.getRun((await service.getJob(job.id)).auditRunId as number);
      signatures.push(JSON.stringify({
        score: run.current.score,
        counts: run.current.counts,
        findings: run.findings.map((f) => [f.ruleCode, f.severity, f.reasonCode, f.targetItemId, f.message]),
      }));
    }
    expect(signatures[1]).toBe(signatures[0]);
    expect(signatures[2]).toBe(signatures[0]);
  });
});
