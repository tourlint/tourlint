import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { SEVERITY, type Severity } from '@tourlint/shared';
import { DomainException } from '../common/domain.exception';
import { shortFingerprint } from '../engine/fingerprint';
import { BudgetGuard } from '../external/budget-guard';
import { createKtoClient } from '../external/kto';
import { DB_POOL } from '../persistence/db';
import { PgApiCallLogger } from '../persistence/api-call-log.repository';
import { AuditResultRepository, type StoredAuditRun } from '../persistence/audit-result.repository';
import { AuditJobRepository, type AuditJob, type TriggerType } from './audit-job.repository';
import { AuditRunner } from './audit-runner';
import { ProductRepository } from './product.repository';

/**
 * 검수 실행 조율 (API 설계 6-1).
 *
 * 사전 검증 → 큐 적재 → 202 응답까지가 요청 경로다 (p95 500ms). 실제 검수는 그 뒤에서 돈다.
 * 검수는 8곳에 15초가 걸리므로 요청을 붙잡고 있을 수 없다.
 */

/** 동시에 도는 검수 수. 초과분은 큐에서 기다린다 (API 설계 6-1) */
const MAX_RUNNING = 3;
/** 폴링 간격 안내값 */
const POLL_INTERVAL_MS = 2000;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly jobs: AuditJobRepository;
  private readonly products: ProductRepository;
  private readonly results: AuditResultRepository;
  private readonly callLogger: PgApiCallLogger;
  private running = 0;
  /** 돌고 있는 검수들. 테스트가 완료를 기다릴 수 있게 붙잡아 둔다 */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {
    this.jobs = new AuditJobRepository(pool);
    this.products = new ProductRepository(pool);
    this.results = new AuditResultRepository(pool);
    this.callLogger = new PgApiCallLogger(pool);
  }

  /**
   * 검수를 요청한다.
   *
   * 사전 검증 순서가 곧 사용자에게 보이는 우선순위다 —
   * 상품이 없으면 404, 미확정이 남았으면 422, 예산이 없으면 429, 이미 돌고 있으면 기존 작업.
   */
  async requestAudit(productId: number, triggerType: TriggerType): Promise<{ job: AuditJob; created: boolean }> {
    const product = await this.products.findProduct(productId);
    if (product === null) {
      throw new DomainException(HttpStatus.NOT_FOUND, 'NOT_FOUND', '상품을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.', 'PRODUCT');
    }

    // EX-AU-001 — 미확정 관광지가 남아 있으면 검수를 시작하지 않는다
    const unresolved = await this.products.findUnresolvedItems(productId);
    if (unresolved.length > 0) {
      throw new DomainException(
        HttpStatus.UNPROCESSABLE_ENTITY, 'PLACE_UNRESOLVED',
        `관광지 ${unresolved.length}곳이 아직 확정되지 않았습니다. 일정 편집에서 관광지를 선택하거나 검수 대상에서 제외한 뒤 다시 요청해 주세요.`,
        'PRODUCT',
        unresolved.map((u) => ({ field: `items[${u.id}]`, message: `${u.placeLabel} 미확정` })),
      );
    }

    /*
     * 예산 게이트 (FR-OP-003 · 004).
     * 사용자가 누른 검수는 100% 까지 허용한다 — 자동 배치와 달리 미룰 수 없기 때문이다.
     */
    const guard = new BudgetGuard({ counter: this.callLogger });
    const decision = await guard.check(triggerType === 'BATCH' ? 'BATCH' : 'USER_AUDIT');
    if (!decision.allowed) {
      throw new DomainException(
        HttpStatus.TOO_MANY_REQUESTS, decision.reasonCode ?? 'BUDGET_EXHAUSTED',
        '오늘 사용할 수 있는 공사 데이터 조회량을 모두 썼습니다. 내일 다시 시도하거나 관리자에게 예산 상향을 요청해 주세요.',
        'REQUEST',
      );
    }

    // EX-AU-004 — 진행 중인 작업이 있으면 새로 만들지 않고 그것을 돌려준다
    const enqueued = await this.jobs.enqueue(productId, triggerType);
    if (enqueued.created) this.track(this.drain());
    return enqueued;
  }

  async getJob(jobId: number): Promise<AuditJob> {
    const job = await this.jobs.findById(jobId);
    if (job === null) {
      throw new DomainException(HttpStatus.NOT_FOUND, 'NOT_FOUND', '검수 작업을 찾을 수 없습니다. 다시 요청해 주세요.', 'REQUEST');
    }
    return job;
  }

  async getRun(auditRunId: number): Promise<StoredAuditRun> {
    const run = await this.results.findById(auditRunId);
    if (run === null) {
      throw new DomainException(HttpStatus.NOT_FOUND, 'NOT_FOUND', '검수 결과를 찾을 수 없습니다. 목록에서 다시 선택해 주세요.', 'REQUEST');
    }
    return run;
  }

  /**
   * 돌고 있는 검수가 모두 끝날 때까지 기다린다.
   *
   * 요청 경로는 202 를 즉시 돌려주고 검수는 뒤에서 돈다. 테스트가 그 끝을 기다릴 방법이
   * 없으면 "완료 후 조회" 를 검증할 수 없다.
   */
  async waitForIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  private track(promise: Promise<void>): void {
    const wrapped = promise.finally(() => this.inFlight.delete(wrapped));
    this.inFlight.add(wrapped);
  }

  /** 큐를 비운다. 동시 실행 상한을 넘지 않는다 */
  private async drain(): Promise<void> {
    if (this.running >= MAX_RUNNING) return;
    this.running++;
    try {
      const { rows } = await this.pool.query<{ id: string; product_id: string }>(
        `SELECT id, product_id FROM audit_job WHERE status = 'QUEUED' ORDER BY id LIMIT 1`,
      );
      const row = rows[0];
      if (row === undefined) return;
      await this.execute(Number(row.id), Number(row.product_id));
    } catch (e) {
      // 큐 소비 실패가 요청 경로로 새어 나가면 안 된다. 202 는 이미 나갔다
      this.logger.error('검수 큐 소비 실패', e);
    } finally {
      this.running--;
    }
  }

  /** 파이프라인 1~9단계를 돌리고 결과를 저장한다 */
  private async execute(jobId: number, productId: number): Promise<void> {
    try {
      const product = await this.products.findProduct(productId);
      const items = await this.products.findItems(productId);
      if (product === null) throw new Error(`상품이 사라졌다: ${productId}`);

      await this.jobs.markRunning(jobId, items.length);

      const runner = new AuditRunner({
        kto: createKtoClient(this.callLogger),
        onProgress: (done, total) => this.jobs.updateProgress(jobId, done, total),
        // 직전 검수의 지문. 비표출 전환과 판정 필드 변경이 여기서 잡힌다 (FR-MO-004)
        previousFingerprints: await this.results.previousFingerprints(productId),
      });
      const result = await runner.run(product, items);

      const auditRunId = await this.results.save({
        productId,
        executedAt: result.executedAt,
        rulesetVersion: result.rulesetVersion,
        targetCount: result.targetCount,
        failedCount: result.failedCount,
        findings: result.findings,
        fingerprints: result.fingerprints,
        weights: result.weights,
        score: result.score,
      });

      await this.jobs.markDone(jobId, auditRunId, new Date());
    } catch (e) {
      // 검수가 통째로 실패해도 작업은 상태를 남긴다. 어디까지 갔는지가 사용자에게 정보다
      this.logger.error(`검수 실행 실패 (job ${jobId})`, e);
      await this.jobs.markFailed(jobId, 'INTERNAL_ERROR', new Date()).catch(() => undefined);
    }
  }
}

// ── 응답 조립 ─────────────────────────────────────────────────────────

export function toJobResponse(job: AuditJob, includePollHint = false): Record<string, unknown> {
  return {
    jobId: job.id,
    status: job.status,
    productId: job.productId,
    progress: {
      done: job.progressDone,
      total: job.progressTotal,
      label: `${job.progressTotal}곳 중 ${job.progressDone}곳 조회 완료`,
    },
    auditRunId: job.auditRunId,
    ...(job.errorCode === null ? {} : { errorCode: job.errorCode }),
    createdAt: job.createdAt.toISOString(),
    ...(job.finishedAt === null ? {} : { finishedAt: job.finishedAt.toISOString() }),
    ...(includePollHint ? { pollIntervalMs: POLL_INTERVAL_MS } : {}),
  };
}

/**
 * 검수 결과 요약 (API 설계 5-5).
 *
 * `readinessScore` 와 `counts` 는 **조회 시점 재계산 값**이다. `audit_run` 저장값은 실행 시점
 * 기록으로 불변이며, 무시 건수는 `counts.dismissed` 로 병기한다 (FR-AU-046).
 */
export function toRunResponse(run: StoredAuditRun, runFingerprint?: string): Record<string, unknown> {
  const c = run.current;
  return {
    auditRunId: run.id,
    productId: run.productId,
    executedAt: run.executedAt.toISOString(),
    rulesetVersion: run.rulesetVersion,
    isPartial: run.isPartial,
    readinessScore: c.score,
    scoreBreakdown: {
      formula: c.breakdown,
      deduction: c.score === null ? null : 100 - c.score,
      weights: run.weights,
    },
    counts: {
      blocker: c.counts.BLOCKER, error: c.counts.ERROR,
      warning: c.counts.WARNING, unverified: c.counts.UNVERIFIED,
      dismissed: c.dismissedCount,
    },
    needsConfirmationCount: c.needsConfirmationCount,
    targetCount: run.targetCount,
    failedCount: run.failedCount,
    releasable: !c.releaseBlocked,
    releaseBlockedReason: c.releaseBlocked ? `차단 ${c.counts.BLOCKER}건` : null,
    evidence: {
      fetchedAt: run.executedAt.toISOString(),
      targetContentCount: run.targetCount,
      dataFingerprint: runFingerprint === undefined ? null : shortFingerprint(runFingerprint),
      rulesetVersion: run.rulesetVersion,
      delayNotice: '공사 데이터는 당일 변경분이 익일 반영되므로 출발 임박 시 운영기관 최종 확인을 권장합니다',
      source: '출처: ⓒ한국관광공사',
    },
  };
}

export function toFindingsResponse(run: StoredAuditRun, severity?: string): Record<string, unknown> {
  const wanted = SEVERITY.includes(severity as Severity) ? (severity as Severity) : null;
  const content = run.findings
    .filter((f) => wanted === null || f.severity === wanted)
    .map((f) => ({
      findingId: f.id,
      ruleCode: f.ruleCode,
      severity: f.severity,
      reasonCode: f.reasonCode,
      message: f.message,
      target: { itemId: f.targetItemId },
      targetSecondary: f.targetItemId2 === null ? null : { itemId: f.targetItemId2 },
      requiresExternal: f.requiresExternal,
      externalSource: f.externalSource,
      // 외부 참고가 아니면 자체 판정이다 (FR-AU-033 · UI-CM-011)
      sourceBadge: f.requiresExternal ? 'EXTERNAL_REFERENCE' : 'TOURLINT_VERDICT',
      needsConfirmation: f.needsConfirmation,
      dismissed: f.dismissed,
      dismissReason: f.dismissReason,
      confirmed: f.confirmed,
      evidence: f.evidence,
    }));

  return { content, totalElements: content.length };
}
