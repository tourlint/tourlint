import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SEVERITY_WEIGHT_DEFAULT } from '@tourlint/shared';
import type { Finding } from '../engine/rules/types';
import { calculateReadiness } from '../engine/score';
import { AuditResultRepository, type AuditResultToSave, type FingerprintToSave } from './audit-result.repository';

/**
 * **실제 Postgres 로 검증한다.**
 *
 * DB 명세서는 판정 불변식을 상당 부분 **DB 제약과 트리거에 맡긴다** — 차단은 무시할 수 없고
 * (`ck_finding_blocker_not_dismissed`), 부분 검수에는 점수가 없고(`ck_run_partial`),
 * 실행당 콘텐츠별 1행이다(`uq_fp_run_content`). 가짜 커넥션으로는 이 중 무엇도 검증되지 않는다.
 *
 * 로컬:  docker run -d --name tourlint-test-pg -e POSTGRES_PASSWORD=test \
 *          -e POSTGRES_DB=tourlint_test -p 55432:5432 postgres:16-alpine
 *        TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/tourlint_test
 * CI:    postgres 서비스 컨테이너 (.github/workflows/ci.yml)
 */

const URL = process.env.TEST_DATABASE_URL;
let counter = 0;

// CI 에서 조용히 건너뛰면 이 파일은 있으나 마나다. 반드시 돌아야 하는 환경에서는 실패시킨다
if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

describe.skipIf(URL === undefined)('AuditResultRepository — 실 DB', () => {
  let pool: Pool;
  let repo: AuditResultRepository;
  let productId: number;
  let itemId: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 4 });
    repo = new AuditResultRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  /*
   * **전역 TRUNCATE 를 쓰지 않는다.** 테스트 파일이 병렬로 돌면 한 파일의 TRUNCATE 가
   * 다른 파일이 방금 만든 데이터를 지워 버린다. 각자 자기 계정만 만들고 자기 것만 지운다 —
   * `ON DELETE CASCADE` 가 상품 · 실행 · finding · 지문을 함께 걷어 간다.
   */
  let accountId: number;

  afterEach(async () => {
    await pool.query('DELETE FROM account WHERE id = $1', [accountId]);
  });

  beforeEach(async () => {
    const account = await pool.query<{ id: string }>(
      `INSERT INTO account (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`repo-${String(process.pid)}-${String(counter++)}@example.com`],
    );
    accountId = Number(account.rows[0]?.id);
    const product = await pool.query<{ id: string }>(
      `INSERT INTO product (account_id, name, ldong_regn_cd, start_date, nights, transport)
       VALUES ($1, '강릉 2박 3일', '51', DATE '2026-10-22', 2, 'CAR') RETURNING id`,
      [account.rows[0]?.id],
    );
    productId = Number(product.rows[0]?.id);

    // finding.target_item_id 가 실제 일정 항목을 가리켜야 한다 (FK)
    const item = await pool.query<{ id: string }>(
      `INSERT INTO itinerary_item
         (product_id, day_no, seq, start_time, end_time, end_time_source,
          place_label, item_type, kto_content_id, content_type_id, match_status)
       VALUES ($1, 1, 1, TIME '12:00', TIME '13:00', 'INPUT',
               '가람집옹심이', 'MEAL', '125266', 39, 'CONFIRMED') RETURNING id`,
      [productId],
    );
    itemId = Number(item.rows[0]?.id);
  });

  const finding = (over: Partial<Finding> = {}): Finding => ({
    ruleCode: 'R01', ruleVersion: '1.0.0', severity: 'BLOCKER', reasonCode: 'REST_DAY_CONFLICT',
    targetItemId: itemId as number | null, message: '가람집옹심이 — 10/13(화) 매주 화요일 휴무',
    evidence: { step: '1-4', date: '2026-10-13' },
    requiresExternal: false, externalSource: null, needsConfirmation: false, ...over,
  });

  const fingerprint = (over: Partial<FingerprintToSave> = {}): FingerprintToSave => ({
    ktoContentId: '125266', contentTypeId: 39, fetchedAt: new Date('2026-10-01T00:00:00Z'),
    ktoModifiedTime: '20260820103000', showFlag: 1,
    fieldNames: ['restdatefood', 'opentimefood'], fieldHash: 'a'.repeat(64),
    normalizedJson: { schemaVersion: '1.0', alwaysOpen: true }, parseConfidence: 'CONFIRMED', ...over,
  });

  const build = (over: Partial<AuditResultToSave> = {}): AuditResultToSave => {
    const findings = over.findings ?? [finding()];
    const targetCount = over.targetCount ?? 8;
    const failedCount = over.failedCount ?? 0;
    return {
      productId, executedAt: new Date('2026-10-01T09:00:00Z'), rulesetVersion: '1.0.0',
      targetCount, failedCount, findings, fingerprints: over.fingerprints ?? [fingerprint()],
      weights: SEVERITY_WEIGHT_DEFAULT,
      score: calculateReadiness({
        findings: findings.map((f) => ({ ...f, dismissed: false })),
        targetCount, failedCount,
      }),
      ...over,
    };
  };

  describe('저장', () => {
    it('세 테이블을 함께 쓴다', async () => {
      const runId = await repo.save(build());

      const run = await pool.query('SELECT * FROM audit_run WHERE id = $1', [runId]);
      const findings = await pool.query('SELECT * FROM finding WHERE audit_run_id = $1', [runId]);
      const fps = await pool.query('SELECT * FROM content_fingerprint WHERE audit_run_id = $1', [runId]);

      expect(run.rowCount).toBe(1);
      expect(findings.rowCount).toBe(1);
      expect(fps.rowCount).toBe(1);
      expect(run.rows[0]).toMatchObject({ blocker_cnt: 1, readiness_score: 75, is_partial: false });
    });

    it('가중치를 그대로 스냅샷한다 — 설정 변경이 소급되지 않는다 (DR-CF-006)', async () => {
      const runId = await repo.save(build({ weights: { BLOCKER: 30, ERROR: 12, WARNING: 5, UNVERIFIED: 2 } }));
      const { rows } = await pool.query<{ weight_snapshot: Record<string, number> }>(
        'SELECT weight_snapshot FROM audit_run WHERE id = $1', [runId],
      );
      expect(rows[0]?.weight_snapshot).toEqual({ BLOCKER: 30, ERROR: 12, WARNING: 5, UNVERIFIED: 2 });
    });

    it('확인 필요 여부를 evidence 에 담는다 — 전용 컬럼이 없다', async () => {
      const runId = await repo.save(build({ findings: [finding({ severity: 'WARNING', needsConfirmation: true })] }));
      const { rows } = await pool.query<{ evidence: Record<string, unknown> }>(
        'SELECT evidence FROM finding WHERE audit_run_id = $1', [runId],
      );
      expect(rows[0]?.evidence).toMatchObject({ needsConfirmation: true, step: '1-4' });
    });

    it('실패하면 아무것도 남지 않는다 — 근거 없는 점수를 만들지 않는다', async () => {
      // 해시 형식이 틀리면 ck_fp_hash 가 막는다. 그때 audit_run 만 남으면 안 된다
      await expect(repo.save(build({ fingerprints: [fingerprint({ fieldHash: 'not-a-hash' })] }))).rejects.toThrow();
      const run = await pool.query('SELECT count(*)::int AS n FROM audit_run WHERE product_id = $1', [productId]);
      expect(run.rows[0]).toEqual({ n: 0 });
    });
  });

  describe('DB 제약이 실제로 막는다', () => {
    it('차단은 무시할 수 없다 (DR-IN-006 · PM-NG-001)', async () => {
      const runId = await repo.save(build());
      await expect(
        pool.query(`UPDATE finding SET dismissed_at = now() WHERE audit_run_id = $1`, [runId]),
      ).rejects.toThrow(/ck_finding_blocker_not_dismissed/);
    });

    it('audit_run 은 불변이다 (PM-NG-004)', async () => {
      const runId = await repo.save(build());
      await expect(
        pool.query(`UPDATE audit_run SET readiness_score = 100 WHERE id = $1`, [runId]),
      ).rejects.toThrow(/FORBIDDEN_ACTION/);
    });

    it('finding 은 무시 · 확인 플래그만 고칠 수 있다 (DR-LC-001)', async () => {
      const runId = await repo.save(build({ findings: [finding({ severity: 'WARNING' })] }));
      // 허용
      await expect(pool.query(
        `UPDATE finding SET dismissed_at = now(), dismiss_reason = '현장 확인함' WHERE audit_run_id = $1`, [runId],
      )).resolves.toBeDefined();
      // 금지 — 판정 자체를 고치는 것
      await expect(pool.query(
        `UPDATE finding SET severity = 'WARNING', message = '다른 말' WHERE audit_run_id = $1`, [runId],
      )).rejects.toThrow(/FORBIDDEN_ACTION/);
    });

    it('부분 검수에는 점수를 넣을 수 없다 (DR-IN-005)', async () => {
      await expect(pool.query(
        `INSERT INTO audit_run (product_id, executed_at, ruleset_version, readiness_score, is_partial,
                                target_count, failed_count, weight_snapshot)
         VALUES ($1, now(), '1.0.0', 88, TRUE, 8, 5, '{}'::jsonb)`, [productId],
      )).rejects.toThrow(/ck_run_partial/);
    });

    it('실행당 콘텐츠별 1행이다 (DR-FP-007)', async () => {
      await expect(repo.save(build({ fingerprints: [fingerprint(), fingerprint()] })))
        .rejects.toThrow(/uq_fp_run_content/);
    });

    it('지문 해시는 소문자 16진 64자여야 한다 (DR-FP-001)', async () => {
      await expect(repo.save(build({ fingerprints: [fingerprint({ fieldHash: 'A'.repeat(64) })] })))
        .rejects.toThrow(/ck_fp_hash/);
    });

    it('수정안은 최대 3개다 (FR-PA-002)', async () => {
      const runId = await repo.save(build({ findings: [finding({ severity: 'WARNING' })] }));
      await expect(pool.query(
        `UPDATE finding SET patches = '[1,2,3,4]'::jsonb WHERE audit_run_id = $1`, [runId],
      )).rejects.toThrow();
    });
  });

  describe('조회 — 점수를 다시 계산한다 (FR-AU-046)', () => {
    it('저장값과 재계산값을 함께 준다', async () => {
      const runId = await repo.save(build({
        findings: [finding({ severity: 'ERROR' }), finding({ severity: 'WARNING' })],
      }));
      const run = await repo.findById(runId);
      expect(run?.storedScore).toBe(86);
      expect(run?.current.score).toBe(86);
      expect(run?.findings).toHaveLength(2);
    });

    it('무시하면 조회 점수만 올라가고 저장값은 그대로다', async () => {
      const runId = await repo.save(build({
        findings: [finding({ severity: 'ERROR' }), finding({ severity: 'WARNING' })],
      }));
      await pool.query(
        `UPDATE finding SET dismissed_at = now() WHERE audit_run_id = $1 AND severity = 'ERROR'`, [runId],
      );

      const run = await repo.findById(runId);
      // 과거 audit_run 의 저장값은 바뀌지 않는다 (PM-NG-004)
      expect(run?.storedScore).toBe(86);
      // 화면·리포트에 쓰는 값은 조회 시점 재계산이다
      expect(run?.current.score).toBe(96);
      expect(run?.current.dismissedCount).toBe(1);
    });

    it('무시를 되돌리면 점수도 돌아온다', async () => {
      const runId = await repo.save(build({ findings: [finding({ severity: 'ERROR' })] }));
      await pool.query(`UPDATE finding SET dismissed_at = now() WHERE audit_run_id = $1`, [runId]);
      expect((await repo.findById(runId))?.current.score).toBe(100);
      await pool.query(`UPDATE finding SET dismissed_at = NULL WHERE audit_run_id = $1`, [runId]);
      expect((await repo.findById(runId))?.current.score).toBe(90);
    });

    it('확인 필요 건수를 evidence 에서 되살린다', async () => {
      const runId = await repo.save(build({
        findings: [finding({ severity: 'WARNING', needsConfirmation: true }), finding({ severity: 'ERROR' })],
      }));
      expect((await repo.findById(runId))?.current.needsConfirmationCount).toBe(1);
    });

    it('없는 실행은 null 이다', async () => {
      expect(await repo.findById(999999)).toBeNull();
    });
  });

  describe('직전 지문 조회 (FR-MO-004)', () => {
    it('저장한 지문을 contentid 로 찾는다', async () => {
      await repo.save(build());
      const prev = await repo.previousFingerprints(productId);
      expect(prev.get('125266')).toEqual({
        fieldNames: ['restdatefood', 'opentimefood'],
        fieldHash: 'a'.repeat(64),
        showFlag: 1,
        ktoModifiedTime: '20260820103000',
      });
    });

    it('가장 최근 실행의 지문을 준다', async () => {
      await repo.save(build());
      await repo.save(build({
        executedAt: new Date('2026-10-05T09:00:00Z'),
        fingerprints: [fingerprint({ fetchedAt: new Date('2026-10-05T09:00:00Z'), fieldHash: 'c'.repeat(64), showFlag: 0 })],
      }));
      const prev = await repo.previousFingerprints(productId);
      expect(prev.get('125266')).toMatchObject({ fieldHash: 'c'.repeat(64), showFlag: 0 });
    });

    it('다른 상품의 지문은 섞이지 않는다', async () => {
      // 다른 상품이 먼저 검수해 만든 지문을 직전으로 삼으면
      // 이 상품 사용자는 못 본 변경을 "이미 알렸다" 고 넘긴다
      await repo.save(build());
      const other = await pool.query<{ id: string }>(
        `INSERT INTO product (account_id, name, ldong_regn_cd, start_date, nights, transport)
         VALUES ($1, '다른 상품', '51', DATE '2026-10-22', 1, 'CAR') RETURNING id`,
        [accountId],
      );
      expect((await repo.previousFingerprints(Number(other.rows[0]?.id))).size).toBe(0);
    });

    it('검수한 적 없으면 비어 있다 — 최초 검수다', async () => {
      expect((await repo.previousFingerprints(productId)).size).toBe(0);
    });
  });

  describe('무저장 경계 (DR-PR-001 · SC-DT-005)', () => {
    it('공사 원문을 담을 컬럼이 스키마에 없다', async () => {
      const { rows } = await pool.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public'
            AND column_name ~ '(overview|firstimage|homepage|addr1|restdate|usetime|opentime|sigungucode)'`,
      );
      expect(rows).toEqual([]);
    });

    it('이용자 위치정보 컬럼이 없다 (SC-DT-012 · PM-NG-013)', async () => {
      const { rows } = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name ~ '(user_lat|user_lng|gps|user_location)'`,
      );
      expect(rows).toEqual([]);
    });

    it('저장된 지문에서 공사 원문 문자열을 찾을 수 없다', async () => {
      // 정규화 결과는 자체 산출물이라 저장하지만, 원문은 지문(해시)으로만 남는다
      const runId = await repo.save(build());
      const { rows } = await pool.query<{ normalized_json: Record<string, unknown> }>(
        'SELECT normalized_json FROM content_fingerprint WHERE audit_run_id = $1', [runId],
      );
      const json = JSON.stringify(rows[0]?.normalized_json);
      expect(json).not.toContain('연중무휴');
      expect(json).not.toContain('restdatefood');
    });
  });
});
