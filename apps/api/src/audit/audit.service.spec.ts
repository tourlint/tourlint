import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditService,
  toFindingsResponse,
  toJobResponse,
  toComparisonResponse,
  toPatchApplicationResponse,
  toRulesResponse,
  toRunListResponse,
  toRunResponse,
  toUnverifiedResponse,
} from './audit.service';
import { DomainException } from '../common/domain.exception';
import { RULES, RULESET_VERSION } from './rule-registry';

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
    process.env.KAKAO_MODE = 'fixture';
    process.env.KAKAO_FIXTURE_DIR = join(__dirname, '../../../../fixtures/kakao');
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
    /*
     * 위쪽 경계를 같이 건다. 이 테스트가 만든 행만 지우려는 것인데 아래 경계만 두면
     * 다른 스펙이 넣은 **미래 날짜** 행까지 쓸어 간다 — 실제로 usage 스펙이 그렇게 깨졌다.
     */
    await pool.query(
      `DELETE FROM api_call_log WHERE called_at >= $1 AND called_at < now() + interval '1 minute'`,
      [since],
    );
    /*
     * `patch_application.applied_by` 는 CASCADE 가 아니라(DB 명세서 3-8) 계정 삭제를 막는다.
     * 서비스가 탈퇴를 제공하지 않기로 한 결정과 맞는 제약이므로(권한 4-2) 스키마가 아니라
     * 정리 순서를 맞춘다.
     */
    await pool.query(
      'DELETE FROM patch_application WHERE product_id IN (SELECT id FROM product WHERE account_id = $1)',
      [accountId],
    );
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
            item_type, kto_content_id, content_type_id, lcls_systm2, mapx, mapy, match_status)
         VALUES ($1,$2,$3,$4::time,$5::time,'INPUT',$6,$7,$8,$9,$10,128.8961,37.7952,'CONFIRMED')`,
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

  /** 검수를 한 번 돌려 수정안이 붙은 finding 을 얻는다 */
  const runAndPick = async (): Promise<{ findingId: number; patchId: string }[]> => {
    const { job } = await service.requestAudit(productId, 'INITIAL');
    await service.waitForIdle();
    const run = await service.getRun((await service.getJob(job.id)).auditRunId as number);
    return run.findings
      .filter((f) => f.patches.length > 0)
      .map((f) => ({ findingId: f.id, patchId: f.patches[0]?.patchId ?? '' }));
  };

  const pick = (picks: { findingId: number; patchId: string }[], i = 0): { findingId: number; patchId: string } =>
    picks[i] as { findingId: number; patchId: string };

  describe('수정안 미리보기 (F08 · FR-PA-004 ~ 007)', () => {
    it('충돌 여부와 반영 전후 일정을 돌려준다 — 아무것도 저장하지 않는다', async () => {
      const picks = await runAndPick();
      expect(picks.length).toBeGreaterThan(0);

      const before = await pool.query('SELECT count(*)::text AS n FROM patch_application');
      const preview = await service.previewPatches(productId, [pick(picks)]);
      const after = await pool.query('SELECT count(*)::text AS n FROM patch_application');

      expect(preview.previewToken).toMatch(/^pv_[0-9a-f]{12}$/);
      expect(preview.conflict.hasConflict).toBe(false);
      expect(preview.before.length).toBeGreaterThan(0);
      // 확정 전에는 이력이 안 생긴다
      expect(after.rows[0]).toEqual(before.rows[0]);
    });

    it('🔴 다른 상품의 finding 으로는 미리 볼 수 없다', async () => {
      /*
       * finding id 만 알면 남의 일정을 들여다볼 수 있으면 안 된다. 상품 소유 확인이
       * SQL 안에 있어야 호출 경로가 늘어도 안 샌다.
       */
      const picks = await runAndPick();
      const other = await pool.query<{ id: string }>(
        `INSERT INTO product (account_id, name, ldong_regn_cd, start_date, nights, transport)
         VALUES ($1,'남의 상품','51', DATE '2026-10-13', 1, 'CAR') RETURNING id`,
        [accountId],
      );
      const otherId = Number(other.rows[0]?.id);

      await expect(
        service.previewPatches(otherId, [picks[0] as { findingId: number; patchId: string }]),
      ).rejects.toMatchObject({ reasonCode: 'PATCH_STALE' });
    });

    it('사라진 수정안은 조용히 빼지 않는다 — 고르지 않은 결과를 주면 안 된다', async () => {
      await expect(
        service.previewPatches(productId, [{ findingId: 99_999_999, patchId: 'p-1' }]),
      ).rejects.toMatchObject({ reasonCode: 'PATCH_STALE' });
    });

    it('선택이 비어 있으면 미리 볼 것이 없다', async () => {
      await expect(service.previewPatches(productId, [])).rejects.toMatchObject({ reasonCode: 'PATCH_STALE' });
    });
  });

  describe('패치 확정 · 되돌리기 (F09 · FR-PA-020 ~ 028)', () => {
    /** 확정하고 재검수가 끝날 때까지 기다린다 */
    const confirmAndSettle = async (
      selections: { findingId: number; patchId: string }[],
      token: string | null = null,
    ): Promise<Awaited<ReturnType<typeof service.confirmPatches>>> => {
      const applied = await service.confirmPatches(productId, selections, token);
      await service.waitForIdle();
      return applied;
    };

    const itemsOf = async (): Promise<{ id: number; day_no: number; seq: number; start_time: string }[]> => {
      const { rows } = await pool.query<{ id: string; day_no: number; seq: number; start_time: string }>(
        `SELECT id, day_no, seq, start_time FROM itinerary_item WHERE product_id = $1 ORDER BY day_no, seq`,
        [productId],
      );
      return rows.map((r) => ({ ...r, id: Number(r.id) }));
    };

    /**
     * 수정안이 붙은 finding 을 직접 만든다.
     *
     * 픽스처가 어떤 유형을 만들어 주느냐에 기대면, 규칙이 바뀌는 날 검사가 조용히
     * 빈 채로 통과한다 — 확인하려는 것은 규칙이 아니라 **확정 경로**다.
     */
    const synthFinding = async (patches: readonly Record<string, unknown>[]): Promise<number> => {
      await pool.query(
        `INSERT INTO audit_run (product_id, executed_at, ruleset_version, target_count, weight_snapshot)
         VALUES ($1, now(), 'v1.3.0', 3, '{"BLOCKER":50,"ERROR":10,"WARNING":4,"UNVERIFIED":3}'::jsonb)`,
        [productId],
      );
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO finding (audit_run_id, rule_code, rule_version, severity, reason_code,
                              target_item_id, message, evidence, requires_external, patches)
         SELECT id, 'R03', '1.0.0', 'ERROR', 'TIME_OVERLAP',
                $2, '테스트용 수정안', '{}'::jsonb, false, $3::jsonb
           FROM audit_run WHERE product_id = $1 ORDER BY id DESC LIMIT 1
         RETURNING id`,
        [productId, patches[0]?.targetItemId ?? null, JSON.stringify(patches)],
      );
      return Number(rows[0]?.id);
    };

    /** 1일차 항목 id 를 순서대로 */
    const day1Ids = async (): Promise<number[]> => {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM itinerary_item WHERE product_id = $1 AND day_no = 1 ORDER BY seq`, [productId],
      );
      return rows.map((r) => Number(r.id));
    };

    it('일정을 바꾸고 이력을 남긴다 — 전후 스냅샷이 함께 저장된다 (FR-PA-021 · 028)', async () => {
      const picks = await runAndPick();
      const before = await itemsOf();
      const applied = await confirmAndSettle([pick(picks)]);

      const { rows } = await pool.query<{
        selected_patches: unknown[]; before_snapshot: { items: unknown[] };
        after_snapshot: { items: unknown[] }; before_audit_run_id: string | null;
        after_audit_run_id: string | null; applied_by: string;
      }>(`SELECT selected_patches, before_snapshot, after_snapshot, before_audit_run_id,
                 after_audit_run_id, applied_by
            FROM patch_application WHERE id = $1`, [applied.patchApplicationId]);
      const row = rows[0];

      expect(row?.selected_patches).toHaveLength(1);
      expect(row?.before_snapshot.items).toHaveLength(before.length);
      expect(Number(row?.before_audit_run_id)).toBe(applied.beforeAuditRunId);
      expect(Number(row?.applied_by)).toBe(accountId);
      // 재검수 결과가 이력의 오른쪽에 붙는다 (FR-PA-025 · 전후 비교)
      expect(row?.after_audit_run_id).not.toBeNull();
      expect(Number(row?.after_audit_run_id)).not.toBe(applied.beforeAuditRunId);
    });

    it('🔴 수정안을 여럿 골라도 재검수는 정확히 1회다 (FR-PA-022)', async () => {
      const picks = await runAndPick();
      /*
       * 충돌하지 않는 선택만 고른다. 같은 항목을 건드리는 둘은 확정 자체가 막히므로
       * "여러 건을 확정했다" 는 전제가 성립하지 않는다.
       */
      const chosen: { findingId: number; patchId: string }[] = [];
      for (const p of picks) {
        const candidate = [...chosen, p];
        if (!(await service.previewPatches(productId, candidate)).conflict.hasConflict) chosen.push(p);
      }
      expect(chosen.length).toBeGreaterThan(1);

      const count = async (table: 'audit_job' | 'audit_run'): Promise<number> => {
        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${table} WHERE product_id = $1`, [productId],
        );
        return Number(rows[0]?.n);
      };
      const jobsBefore = await count('audit_job');
      const runsBefore = await count('audit_run');

      await confirmAndSettle(chosen);

      /*
       * 세는 것은 작업 수가 아니라 **검수 실행 수**다. `uq_job_active` 가 동시 중복을 막아
       * 주므로 작업만 세면 수정안마다 돌리는 코드도 1 로 보인다 — 순서대로 돌면 작업은
       * 하나씩이어도 `audit_run` 은 선택 수만큼 쌓인다.
       */
      expect(await count('audit_run')).toBe(runsBefore + 1);
      expect(await count('audit_job')).toBe(jobsBefore + 1);
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_job WHERE product_id = $1 AND trigger_type = 'PATCH'`,
        [productId],
      );
      expect(Number(rows[0]?.n)).toBe(1);
    });

    it('이전 audit_run 을 지우지 않는다 — 새로 만든다 (FR-PA-025)', async () => {
      const picks = await runAndPick();
      const applied = await confirmAndSettle([pick(picks)]);

      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM audit_run WHERE product_id = $1 ORDER BY id`, [productId],
      );
      expect(rows.map((r) => Number(r.id))).toContain(applied.beforeAuditRunId);
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });

    it('🔴 자리를 맞바꾸는 수정안도 반영된다 — 순서 제약에 걸려 터지면 안 된다', async () => {
      /*
       * `uq_item_product_day_seq` 는 (상품, 일차, 순서)를 유일하게 잡는다. 두 항목이
       * 자리를 바꾸면 중간 상태에서 반드시 겹치는데, 제약이 `DEFERRABLE` 이 아니라
       * 커밋까지 미룰 수도 없다. 여기서 터지면 확정 경로 전체가 못 쓴다.
       */
      /*
       * 순서를 1 · 2 로 맞춰 두고 시작한다. 픽스처의 2 · 3 그대로면 맞바꾼 뒤 쓰는 값이
       * 1 · 2 라 쓰는 동안 아무 자리도 겹치지 않는다 — 제약을 건드리지 못하는 검사가 된다.
       */
      const [first, second] = await day1Ids();
      await pool.query(`UPDATE itinerary_item SET seq = 1 WHERE id = $1`, [first]);
      await pool.query(`UPDATE itinerary_item SET seq = 2 WHERE id = $1`, [second]);

      const [a, b] = await day1Ids();
      const findingId = await synthFinding([
        { patchId: 'p-1', type: 'REORDER', targetItemId: a, payload: { swapWithItemId: b } },
      ]);

      const applied = await confirmAndSettle([{ findingId, patchId: 'p-1' }]);

      expect(applied.patchApplicationId).toBeGreaterThan(0);
      // 두 항목이 시각을 맞바꿨으므로 순서도 뒤집혀 있다
      expect((await itemsOf()).filter((i) => i.day_no === 1).map((i) => i.id)).toEqual([b, a]);
    });

    it('🔴 새로 넣은 식사·휴식은 매칭 대상이 아니다 — 확정 뒤 검수가 막히면 안 된다', async () => {
      /*
       * `INSERT_ITEM` 이 넣는 것은 식사·휴식처럼 공사에 물어볼 것이 없는 시간대다.
       * 이걸 `PENDING` 으로 두면 두 가지가 무너진다 —
       * ① R05 가 이름도 없는 항목을 "어느 관광지인지 확정되지 않았다" 며 확인 불가로 세고,
       * ② 다음 사용자 검수가 `PLACE_UNRESOLVED` 로 거절당해 아예 못 돌린다 (EX-AU-001).
       */
      const [a] = await day1Ids();
      const findingId = await synthFinding([
        {
          patchId: 'p-1', type: 'INSERT_ITEM', targetItemId: a,
          payload: { dayNo: 1, afterItemId: a, startTime: '18:00', endTime: '19:00', itemType: 'MEAL' },
        },
      ]);
      const applied = await confirmAndSettle([{ findingId, patchId: 'p-1' }]);

      const { rows } = await pool.query<{ match_status: string; kto_content_id: string | null }>(
        `SELECT match_status, kto_content_id FROM itinerary_item
          WHERE product_id = $1 AND item_type = 'MEAL' AND start_time = '18:00'::time`, [productId],
      );
      expect(rows[0]?.match_status).toBe('EXCLUDED');
      expect(rows[0]?.kto_content_id).toBeNull();

      // ① 넣은 항목이 확인 불가로 세어지지 않는다
      const application = await service.getPatchApplication(applied.patchApplicationId);
      const afterRun = await service.findRun(application.afterAuditRunId);
      expect(afterRun).not.toBeNull();
      const codes = (afterRun?.findings ?? []).map((f) => String(f.reasonCode));
      expect(codes).not.toContain('PLACE_UNRESOLVED');

      // ② 사용자가 다시 검수를 눌러도 거절당하지 않는다
      await expect(service.requestAudit(productId, 'MANUAL')).resolves.toBeDefined();
      await service.waitForIdle();
    });

    it('🔴 충돌하면 확정하지 않는다 — 어느 둘인지 지목한다 (FR-PA-006 · EX-PA-001)', async () => {
      // 같은 항목을 둘이 함께 건드리게 만든다. 픽스처가 충돌을 내주기를 기다리지 않는다
      const [a] = await day1Ids();
      const first = await synthFinding([
        { patchId: 'p-1', type: 'TIME_SHIFT', targetItemId: a, payload: { newStartTime: '15:00', newEndTime: '16:00' } },
      ]);
      const second = await synthFinding([
        { patchId: 'p-1', type: 'REMOVE_ITEM', targetItemId: a, payload: {} },
      ]);
      const conflicting = [{ findingId: first, patchId: 'p-1' }, { findingId: second, patchId: 'p-1' }];
      expect((await service.previewPatches(productId, conflicting)).conflict.hasConflict).toBe(true);

      const before = await itemsOf();
      const e = await service.confirmPatches(productId, conflicting, null).catch((x: unknown) => x);
      expect((e as DomainException).reasonCode).toBe('PATCH_CONFLICT');
      expect((e as DomainException).getStatus()).toBe(409);
      // 어느 둘이 부딪혔는지 지목한다 (FR-PA-006)
      expect((e as DomainException).fieldErrors?.[0]?.field).toContain(String(first));
      // 막혔으면 일정은 그대로다
      expect(await itemsOf()).toEqual(before);
    });

    it('🔴 미리 본 뒤 일정이 바뀌었으면 거절한다 (EX-PA-002)', async () => {
      const picks = await runAndPick();
      const preview = await service.previewPatches(productId, [pick(picks)]);

      // 다른 경로로 일정이 바뀐 상황
      await pool.query(
        `UPDATE itinerary_item SET start_time = '08:00'::time
          WHERE product_id = $1 AND day_no = 2 AND seq = 1`, [productId],
      );

      await expect(
        service.confirmPatches(productId, [pick(picks)], preview.previewToken),
      ).rejects.toMatchObject({ reasonCode: 'PATCH_STALE' });
    });

    it('되돌리면 일정이 확정 직전으로 돌아간다 (FR-PA-026)', async () => {
      const picks = await runAndPick();
      const before = await itemsOf();
      const applied = await confirmAndSettle([pick(picks)]);
      expect(await itemsOf()).not.toEqual(before);

      const { revertedAt } = await service.revertPatch(applied.patchApplicationId);
      expect(revertedAt).toBeInstanceOf(Date);
      // 항목 id 까지 그대로다 — 이전 검수 결과가 가리키는 대상이 살아 있어야 한다
      expect(await itemsOf()).toEqual(before);
    });

    it('🔴 되돌리기는 직전 1건까지다 (EX-PA-006)', async () => {
      const picks = await runAndPick();
      const first = await confirmAndSettle([pick(picks)]);

      // 첫 확정으로 일정이 바뀐 뒤라 남아 있는 항목으로 두 번째를 만든다
      const [surviving] = await day1Ids();
      expect(surviving).toBeDefined();
      const findingId = await synthFinding([
        { patchId: 'p-1', type: 'TIME_SHIFT', targetItemId: surviving, payload: { newStartTime: '16:00', newEndTime: '17:00' } },
      ]);
      const second = await confirmAndSettle([{ findingId, patchId: 'p-1' }]);
      expect(second.patchApplicationId).toBeGreaterThan(first.patchApplicationId);

      // 두 단계 전으로 돌아가려 하면 그 사이 확정한 선택이 소리 없이 사라진다
      await expect(service.revertPatch(first.patchApplicationId)).rejects.toMatchObject({
        reasonCode: 'UNDO_UNAVAILABLE',
      });
      // 직전 1건은 여전히 되돌릴 수 있다
      await expect(service.revertPatch(second.patchApplicationId)).resolves.toBeDefined();
    });

    it('🔴 같은 패치를 두 번 되돌리지 않는다 (EX-PA-006)', async () => {
      const picks = await runAndPick();
      const applied = await confirmAndSettle([pick(picks)]);
      await service.revertPatch(applied.patchApplicationId);

      await expect(service.revertPatch(applied.patchApplicationId)).rejects.toMatchObject({
        reasonCode: 'UNDO_UNAVAILABLE',
      });
    });

    it('검수가 도는 중에는 확정을 받지 않는다 — 패치 전 일정을 검수하는 작업을 내주면 안 된다', async () => {
      const picks = await runAndPick();
      await pool.query(
        `INSERT INTO audit_job (product_id, status, trigger_type) VALUES ($1, 'RUNNING', 'MANUAL')`,
        [productId],
      );

      await expect(service.confirmPatches(productId, [pick(picks)], null)).rejects.toMatchObject({
        reasonCode: 'PATCH_STALE',
      });
      await pool.query(`DELETE FROM audit_job WHERE product_id = $1 AND status = 'RUNNING'`, [productId]);
    });

    it('🔴 대상이 사라진 수정안이 섞이면 통째로 거절한다 — 부분 반영을 남기지 않는다 (EX-PA-003)', async () => {
      const picks = await runAndPick();
      const [a, b] = await day1Ids();
      // 살아 있는 항목 하나 + 지워질 항목 하나를 함께 고른다
      const doomed = await synthFinding([
        { patchId: 'p-1', type: 'TIME_SHIFT', targetItemId: b, payload: { newStartTime: '20:00', newEndTime: '21:00' } },
      ]);
      const alive = await synthFinding([
        { patchId: 'p-1', type: 'TIME_SHIFT', targetItemId: a, payload: { newStartTime: '09:00', newEndTime: '10:00' } },
      ]);
      expect(picks.length).toBeGreaterThan(0);

      await pool.query(`DELETE FROM itinerary_item WHERE id = $1`, [b]);
      const before = await itemsOf();

      const e = await service.confirmPatches(
        productId, [{ findingId: alive, patchId: 'p-1' }, { findingId: doomed, patchId: 'p-1' }], null,
      ).catch((x: unknown) => x);
      expect((e as DomainException).reasonCode).toBe('PATCH_STALE');
      // 살아 있던 쪽도 반영되지 않았다
      expect(await itemsOf()).toEqual(before);
    });

    it('재검수가 실패해 오른쪽이 빈 이력은 다음 검수가 채운다 (EX-PA-004)', async () => {
      const picks = await runAndPick();
      const applied = await confirmAndSettle([pick(picks)]);
      // 자동 재검수가 실패한 상황을 만든다
      await pool.query(`UPDATE patch_application SET after_audit_run_id = NULL WHERE id = $1`,
        [applied.patchApplicationId]);

      await service.requestAudit(productId, 'MANUAL');
      await service.waitForIdle();

      const application = await service.getPatchApplication(applied.patchApplicationId);
      expect(application.afterAuditRunId).not.toBeNull();
    });

    it('🔴 되돌린 이력에는 붙이지 않는다 — 있지도 않은 상태를 견주게 된다', async () => {
      const picks = await runAndPick();
      const applied = await confirmAndSettle([pick(picks)]);
      await pool.query(`UPDATE patch_application SET after_audit_run_id = NULL WHERE id = $1`,
        [applied.patchApplicationId]);
      await service.revertPatch(applied.patchApplicationId);

      await service.requestAudit(productId, 'MANUAL');
      await service.waitForIdle();

      const application = await service.getPatchApplication(applied.patchApplicationId);
      expect(application.afterAuditRunId).toBeNull();
    });

    it('준비도가 떨어져도 자동으로 되돌리지 않는다 — 경고만 남긴다 (FR-PA-027)', async () => {
      const picks = await runAndPick();
      const applied = await confirmAndSettle([pick(picks)]);

      const application = await service.getPatchApplication(applied.patchApplicationId);
      expect(application.revertedAt).toBeNull();

      const [beforeRun, afterRun, latest] = await Promise.all([
        service.findRun(application.beforeAuditRunId),
        service.findRun(application.afterAuditRunId),
        service.latestPatchApplication(productId),
      ]);
      const body = toPatchApplicationResponse(application, beforeRun, afterRun, latest?.id === application.id);

      expect(body.revertible).toBe(true);
      expect(body.reauditStatus).toBe('DONE');
      // 좋아졌으면 배너가 없고, 나빠졌으면 문구가 있다. 어느 쪽이든 일정은 그대로다
      const banner = body.warningBanner;
      expect(banner === null || typeof banner === 'string').toBe(true);
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

  describe('전후 비교 (F10 · FR-PA-040 ~ 044)', () => {
    /** 검수 → 수정안 확정 → 재검수까지 한 바퀴 돌린다 */
    async function applyOnce(): Promise<void> {
      const { job } = await service.requestAudit(productId, 'INITIAL');
      await service.waitForIdle();
      const runId = (await service.getJob(job.id)).auditRunId as number;

      const run = await service.getRun(runId);
      const withPatch = run.findings.find((f) => f.patches.length > 0);
      expect(withPatch, '픽스처에 수정안이 붙은 판정이 있어야 이 검사가 뜻이 있다').toBeDefined();

      const selection = [{ findingId: withPatch!.id, patchId: withPatch!.patches[0]!.patchId }];
      const preview = await service.previewPatches(productId, selection);
      await service.confirmPatches(productId, selection, preview.previewToken);
      await service.waitForIdle();
    }

    it('비교할 이력이 없으면 404 다 — 빈 비교를 만들어 주지 않는다', async () => {
      await expect(service.getComparison(productId)).rejects.toMatchObject({ reasonCode: 'NOT_FOUND' });
    });

    it('명세 5-9 형식으로 전후를 준다', async () => {
      await applyOnce();
      const { application, before, after } = await service.getComparison(productId);
      const body = toComparisonResponse(application, before, after);

      expect(body).toMatchObject({ patchApplicationId: application.id, revertible: true });
      expect((body.before as Record<string, unknown>).auditRunId).toBe(before.id);
      expect((body.after as Record<string, unknown>).auditRunId).toBe(after.id);
      expect(after.id).toBeGreaterThan(before.id);
    });

    it('🔴 지표 아홉 종이 다 있다 (FR-PA-040)', async () => {
      await applyOnce();
      const { application, before, after } = await service.getComparison(productId);
      const keys = (toComparisonResponse(application, before, after).metrics as { key: string }[])
        .map((m) => m.key);

      expect(keys).toEqual([
        'blocker', 'error', 'warning', 'unverified',
        'deduction', 'readinessScore', 'travelMinutes', 'travelMeters', 'targetFit',
      ]);
    });

    it('🔴 총 감점에 계산식이 붙는다 — 화면에서 검산할 수 있어야 한다 (FR-PA-041)', async () => {
      await applyOnce();
      const { application, before, after } = await service.getComparison(productId);
      const metrics = toComparisonResponse(application, before, after).metrics as Record<string, unknown>[];
      const deduction = metrics.find((m) => m.key === 'deduction')!;

      expect(String(deduction.formulaBefore)).toMatch(/^100 − /);
      expect(String(deduction.formulaAfter)).toMatch(/^100 − /);
      // 감점 = 100 − 준비도
      const score = metrics.find((m) => m.key === 'readinessScore')!;
      expect(Number(deduction.before) + Number(score.before)).toBe(100);
      expect(Number(deduction.after) + Number(score.after)).toBe(100);
    });

    it('이동 지표에 외부 참고 배지가 붙는다 (FR-RU-082)', async () => {
      await applyOnce();
      const { application, before, after } = await service.getComparison(productId);
      const metrics = toComparisonResponse(application, before, after).metrics as Record<string, unknown>[];

      for (const key of ['travelMinutes', 'travelMeters']) {
        const m = metrics.find((x) => x.key === key)!;
        expect(m.sourceBadge).toBe('EXTERNAL_REF');
        expect(m.externalSource).toBe('카카오모빌리티');
      }
    });

    it('🔴 준비도가 떨어져도 자동으로 되돌리지 않는다 (FR-PA-027 · EX-PA-005)', async () => {
      await applyOnce();
      const { application, before, after } = await service.getComparison(productId);
      const body = toComparisonResponse(application, before, after);

      // 이력이 살아 있고 되돌리기 수단이 열려 있다
      expect(body.revertible).toBe(true);
      expect(application.revertedAt).toBeNull();
      // 나빠졌으면 경고 문구가 있고, 아니면 null 이다
      const worse = (after.current.score ?? 0) < (before.current.score ?? 0);
      expect(body.warningBanner === null).toBe(!worse);
    });

    it('🔴 수요 적합성에 판매·흥행 표현이 없다 (FR-RU-104)', async () => {
      await applyOnce();
      const { application, before, after } = await service.getComparison(productId);
      const metrics = toComparisonResponse(application, before, after).metrics as Record<string, unknown>[];
      const fit = metrics.find((m) => m.key === 'targetFit')!;

      for (const word of ['판매', '흥행', '인기', '수요 증가', '매출']) {
        expect(String(fit.beforeText), word).not.toContain(word);
        expect(String(fit.afterText), word).not.toContain(word);
      }
    });

    it('🔴 재검수가 아직 안 끝났으면 404 다 (EX-PA-004)', async () => {
      await applyOnce();
      const { application } = await service.getComparison(productId);
      // 확정이 부른 재검수가 실패했거나 아직 안 끝난 상태를 만든다
      await pool.query('UPDATE patch_application SET after_audit_run_id = NULL WHERE id = $1', [application.id]);

      await expect(service.getComparison(productId)).rejects.toMatchObject({ reasonCode: 'NOT_FOUND' });
    });

    it('되돌린 이력은 비교 대상이 아니다 — 그 일정이 더는 없다', async () => {
      await applyOnce();
      const { application } = await service.getComparison(productId);
      await service.revertPatch(application.id);

      await expect(service.getComparison(productId)).rejects.toMatchObject({ reasonCode: 'NOT_FOUND' });
    });
  });

  describe('무시 · 확인 · 이력 (FR-AU-008 · 045 · 047)', () => {
    /** 검수를 한 번 돌리고 그 실행의 판정 목록을 준다 */
    async function runOnce(): Promise<{ runId: number; findings: readonly { id: number; severity: string }[] }> {
      const { job } = await service.requestAudit(productId, 'INITIAL');
      await service.waitForIdle();
      const runId = (await service.getJob(job.id)).auditRunId as number;
      const run = await service.getRun(runId);
      return { runId, findings: run.findings.map((f) => ({ id: f.id, severity: f.severity })) };
    }

    it('🔴 차단 등급은 무시할 수 없다 (PM-NG-001 · 탈락 사유)', async () => {
      const { findings } = await runOnce();
      const blocker = findings.find((f) => f.severity === 'BLOCKER');
      expect(blocker, '픽스처에 차단이 있어야 이 검사가 뜻이 있다').toBeDefined();

      await expect(service.dismissFinding(blocker!.id, '괜찮음')).rejects.toMatchObject({
        reasonCode: 'FORBIDDEN_ACTION',
      });
      // DB 에도 안 들어갔다
      const { rows } = await pool.query('SELECT dismissed_at FROM finding WHERE id = $1', [blocker!.id]);
      expect(rows[0].dismissed_at).toBeNull();
    });

    it('차단이 아니면 무시되고 점수가 다시 계산된다 (FR-AU-046)', async () => {
      const { runId, findings } = await runOnce();
      const target = findings.find((f) => f.severity !== 'BLOCKER');
      expect(target).toBeDefined();

      const before = (await service.getRun(runId)).current.score as number;
      await service.dismissFinding(target!.id, '현장 확인함');
      const after = await service.getRun(runId);

      expect(after.current.score).toBeGreaterThan(before);
      // 저장 시점 점수는 그대로다 — 실행 기록은 불변이다
      expect(after.storedScore).toBe(before);
      expect(after.findings.find((f) => f.id === target!.id)?.dismissReason).toBe('현장 확인함');
    });

    it('무시를 해제하면 사유도 지워진다', async () => {
      const { runId, findings } = await runOnce();
      const target = findings.find((f) => f.severity !== 'BLOCKER')!;
      await service.dismissFinding(target.id, '사유');
      await service.undismissFinding(target.id);

      const f = (await service.getRun(runId)).findings.find((x) => x.id === target.id);
      expect(f?.dismissed).toBe(false);
      expect(f?.dismissReason).toBeNull();
    });

    it('🔴 확인은 무시와 다르다 — 점수에서 빠지지 않는다', async () => {
      const { runId, findings } = await runOnce();
      const target = findings.find((f) => f.severity === 'UNVERIFIED');
      expect(target).toBeDefined();

      const before = (await service.getRun(runId)).current.score;
      await service.confirmFinding(target!.id);
      const after = await service.getRun(runId);

      expect(after.current.score).toBe(before);
      expect(after.findings.find((f) => f.id === target!.id)?.confirmed).toBe(true);
    });

    it('두 번 확인해도 오류가 아니다', async () => {
      const { findings } = await runOnce();
      const target = findings.find((f) => f.severity === 'UNVERIFIED')!;
      await service.confirmFinding(target.id);
      await expect(service.confirmFinding(target.id)).resolves.toBeUndefined();
    });

    it('없는 판정은 404 다', async () => {
      await expect(service.dismissFinding(999_999_999, null)).rejects.toMatchObject({ reasonCode: 'NOT_FOUND' });
      await expect(service.confirmFinding(999_999_999)).rejects.toMatchObject({ reasonCode: 'NOT_FOUND' });
      await expect(service.undismissFinding(999_999_999)).rejects.toMatchObject({ reasonCode: 'NOT_FOUND' });
    });

    it('확인 필요 목록에 관광지 원문이 없다 (DR-PR-001)', async () => {
      const { runId } = await runOnce();
      const body = toUnverifiedResponse(await service.getRun(runId));

      expect(Number(body.totalCount)).toBeGreaterThan(0);
      // 공사 원문 필드가 응답에 섞이면 무저장 원칙이 깨진다
      const serialized = JSON.stringify(body);
      for (const leak of ['ktoRaw', 'overview', 'usetime', 'restdate', 'homepage']) {
        expect(serialized, leak).not.toContain(leak);
      }
    });

    it('검수 이력이 최신순이고 조회 시점 점수를 준다', async () => {
      await runOnce();
      await runOnce();

      const body = toRunListResponse(await service.listRuns(productId));
      const runs = body.runs as { auditRunId: number; executedAt: string; readinessScore: number }[];
      expect(runs.length).toBeGreaterThanOrEqual(2);
      expect(runs[0]?.auditRunId).toBeGreaterThan(runs[1]?.auditRunId ?? 0);
      expect(runs[0]?.readinessScore).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('규칙 목록 (API 설계 5-10)', () => {
  it('레지스트리를 그대로 낸다 — 목록을 따로 적어 두지 않는다', () => {
    const body = toRulesResponse();
    expect(body.rulesetVersion).toBe(RULESET_VERSION);
    expect(body.rules).toHaveLength(RULES.length);
    expect(body.rules).toHaveLength(10);
  });

  it('🔴 규칙 코드가 R01 ~ R10 이고 중복이 없다', () => {
    // DB 제약(ck_finding_rule)이 이 열 개만 받는다. 어긋나면 저장이 통째로 막힌다
    const codes = (toRulesResponse().rules as { code: string }[]).map((r) => r.code);
    expect(codes).toEqual(['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09', 'R10']);
  });

  it('R06 만 기본 등급이 null 이다 — 변경 내용에 따라 정해진다', () => {
    const rules = toRulesResponse().rules as { code: string; defaultSeverity: string | null }[];
    expect(rules.filter((r) => r.defaultSeverity === null).map((r) => r.code)).toEqual(['R06']);
  });

  it('🔴 외부를 쓰는 규칙만 KTO_PLUS_EXTERNAL 이다', () => {
    // 배지(`requiresExternal`)와 근거(`basis`)가 어긋나면 화면 설명이 서로 다른 말을 한다
    const rules = toRulesResponse().rules as { requiresExternal: boolean; basis: string }[];
    for (const r of rules) {
      expect(r.basis === 'KTO_PLUS_EXTERNAL').toBe(r.requiresExternal);
    }
  });

  it('이름이 비어 있지 않다', () => {
    for (const r of toRulesResponse().rules as { name: string }[]) {
      expect(r.name.trim().length).toBeGreaterThan(0);
    }
  });
});
