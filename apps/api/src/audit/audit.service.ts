import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { SEVERITY, type Severity } from '@tourlint/shared';
import { DomainException } from '../common/domain.exception';
import { shortFingerprint } from '../engine/fingerprint';
import { BudgetGuard } from '../external/budget-guard';
import type { CallIntent } from '../external/budget-guard';
import { KakaoMobilityClient, createKakaoTransport } from '../external/kakao';
import { KmaClient, createKmaTransport } from '../external/kma';
import { createKtoClient } from '../external/kto';
import { DB_POOL } from '../persistence/db';
import { PgApiCallLogger } from '../persistence/api-call-log.repository';
import { AuditResultRepository, type StoredAuditRun } from '../persistence/audit-result.repository';
import { ClimateNormalRepository } from '../persistence/climate-normal.repository';
import {
  PatchApplicationRepository,
  type StoredPatchApplication,
} from '../persistence/patch-application.repository';
import { AuditJobRepository, type AuditJob, type TriggerType } from './audit-job.repository';
import { AuditRunner, type ItineraryItemRow } from './audit-runner';
import { applyPatches } from './patch-apply';
import { checkConflicts, type Conflict, type PatchRef } from './patch-conflict';
import { snapshotToken, toSnapshot } from './patch-snapshot';
import { selectionKey, type SelectedPatch } from './patch-types';
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

/**
 * 미리보기 응답.
 *
 * `previewToken` 은 저장된 표의 열쇠가 아니라 **본 일정 그 자체의 해시**다. 확정 요청이
 * 이 값을 되돌려주면 그 사이 일정이 바뀌었는지 서버가 다시 계산해 맞춰 볼 수 있다
 * (EX-PA-002). 미리보기는 여전히 아무것도 쓰지 않는다.
 */
export interface PatchPreview {
  readonly previewToken: string;
  readonly conflict: { readonly hasConflict: boolean; readonly pairs: readonly Conflict[] };
  readonly before: readonly ItineraryItemRow[];
  readonly after: readonly ItineraryItemRow[];
  /** 대상이 이미 없어 반영하지 못한 선택. 조용히 삼키지 않는다 */
  readonly skipped: readonly { readonly patchId: string; readonly reason: string }[];
}

/** 확정 응답 (API 설계 5-8). 재검수는 뒤에서 돌고 `reauditJobId` 로 따라간다 */
export interface PatchApplied {
  readonly patchApplicationId: number;
  readonly beforeAuditRunId: number | null;
  readonly reauditJobId: number;
  readonly pollIntervalMs: number;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly jobs: AuditJobRepository;
  private readonly products: ProductRepository;
  private readonly results: AuditResultRepository;
  private readonly patchApplications: PatchApplicationRepository;
  private readonly callLogger: PgApiCallLogger;
  private running = 0;
  /** 돌고 있는 검수들. 테스트가 완료를 기다릴 수 있게 붙잡아 둔다 */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {
    this.jobs = new AuditJobRepository(pool);
    this.products = new ProductRepository(pool);
    this.results = new AuditResultRepository(pool);
    this.patchApplications = new PatchApplicationRepository(pool);
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

    await this.assertBudget(triggerType === 'BATCH' ? 'BATCH' : 'USER_AUDIT');

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
   * 고른 수정안을 반영하면 어떻게 되는지 미리 본다 (F08 · FR-PA-004 ~ 007).
   *
   * **아무것도 저장하지 않는다.** 확정은 별도 요청이고, 여기서는 충돌 여부와 반영 후
   * 일정표만 돌려준다. `FR-PA-008` 이 "전체 자동 선택" 을 금지하므로 선택 목록은 항상
   * 사용자가 보낸 그대로다 — 우리가 더하거나 빼지 않는다.
   */
  async previewPatches(
    productId: number,
    selections: readonly PatchRef[],
  ): Promise<PatchPreview> {
    const { items, selected } = await this.resolveSelections(productId, selections);
    const conflict = checkConflicts(items, selected);
    const applied = applyPatches(items, selected);
    return {
      // 확정 요청이 이 값을 되돌려주면 그 사이 일정이 바뀌었는지 알 수 있다 (EX-PA-002)
      previewToken: snapshotToken(items),
      conflict: { hasConflict: conflict.hasConflict, pairs: conflict.conflicts },
      before: items,
      after: applied.items,
      skipped: applied.skipped,
    };
  }

  /**
   * 고른 수정안을 확정한다 (F09 · FR-PA-020 ~ 025 · 028).
   *
   * ## 거절이 먼저다
   *
   * 일정을 쓰고 나서 거절할 일이 생기면 되돌릴 방법이 없다. 그래서 **거절 사유를 전부 앞에
   * 모아** 둔다 — 충돌(EX-PA-001) · 일정 변경(EX-PA-002) · 대상 소실 · 예산 · 진행 중인
   * 검수. 여기를 통과하면 남은 것은 트랜잭션 하나뿐이다 (EX-PA-003).
   *
   * ## 재검수는 정확히 한 번이다
   *
   * 수정안을 넷 골랐든 하나 골랐든 `audit_job` 하나만 만든다 (FR-PA-022). 수정안마다
   * 돌리면 8곳짜리 상품에 공사 호출이 네 배로 들고, 중간 상태를 검수한 결과가 사용자에게
   * 보인다.
   */
  async confirmPatches(
    productId: number,
    selections: readonly PatchRef[],
    previewToken: string | null,
  ): Promise<PatchApplied> {
    const { items, selected } = await this.resolveSelections(productId, selections);

    /*
     * 미리보기 이후 일정이 바뀌었으면 거절한다 (EX-PA-002). 토큰은 일정 자체의 해시라
     * 여기서 다시 계산해 맞춰 본다. 화면이 토큰을 안 보내면 이 검사를 건너뛴다 — 없는
     * 값을 틀렸다고 할 수는 없고, 아래 충돌·대상 소실 검사가 그대로 남는다.
     */
    if (previewToken !== null && previewToken !== snapshotToken(items)) {
      throw new DomainException(
        HttpStatus.CONFLICT, 'PATCH_STALE',
        '미리 본 뒤 일정이 변경되었습니다. 다시 검토한 뒤 확정해 주세요.', 'REQUEST',
      );
    }

    const conflict = checkConflicts(items, selected);
    if (conflict.hasConflict) {
      // 시스템이 하나를 골라 해제하지 않는다. 어느 쪽을 살릴지는 사용자만 안다 (FR-PA-006)
      throw new DomainException(
        HttpStatus.CONFLICT, 'PATCH_CONFLICT',
        '선택한 수정안 사이에 충돌이 있어 확정할 수 없습니다. 충돌하는 수정안 중 하나를 해제해 주세요.',
        'REQUEST',
        conflict.conflicts.map((c) => ({
          field: `${selectionKey(c.a)} ↔ ${selectionKey(c.b)}`,
          message: c.message,
        })),
      );
    }

    const applied = applyPatches(items, selected);
    if (applied.skipped.length > 0) {
      /*
       * 대상이 사라진 수정안이 하나라도 있으면 통째로 거절한다. 미리보기는 못 넣은 것을
       * 알려 주기만 하면 되지만, 확정은 나머지만 반영하는 순간 사용자가 고르지 않은
       * 조합이 일정이 된다 — 부분 반영을 남기지 않는다 (EX-PA-003).
       */
      throw new DomainException(
        HttpStatus.CONFLICT, 'PATCH_STALE',
        '선택한 수정안의 대상 일정이 이미 변경되었습니다. 다시 검토한 뒤 확정해 주세요.', 'REQUEST',
        applied.skipped.map((s) => ({ field: s.patchId, message: s.reason })),
      );
    }

    /*
     * 검수가 돌고 있으면 확정을 받지 않는다.
     *
     * `enqueue` 는 진행 중인 작업이 있으면 그것을 돌려준다 (EX-AU-004). 그대로 두면 확정
     * 응답이 **패치 전 일정을 보고 있는** 작업 번호를 재검수라며 내주고, 정작 바뀐 일정의
     * 재검수는 영영 돌지 않는다. 사유코드 39종에 "진행 중" 이 없어, 확정의 전제가 흔들린
     * 경우로 묶어 `PATCH_STALE` 로 답한다.
     */
    const active = await this.jobs.findActive(productId);
    if (active !== null) {
      throw new DomainException(
        HttpStatus.CONFLICT, 'PATCH_STALE',
        '검수가 진행 중입니다. 끝난 뒤 결과를 확인하고 확정해 주세요.', 'REQUEST',
      );
    }

    // 예산은 쓰기 전에 본다. 다 쓴 뒤 재검수를 못 돌리면 검수 결과 없는 일정만 남는다
    await this.assertBudget('USER_AUDIT');

    const owner = await this.products.findOwner(productId);
    if (owner === null) {
      throw new DomainException(HttpStatus.NOT_FOUND, 'NOT_FOUND', '상품을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.', 'PRODUCT');
    }

    const appliedAt = new Date();
    const beforeAuditRunId = await this.results.latestRunIdOf(productId);
    const saved = await this.patchApplications.apply({
      productId,
      appliedBy: owner,
      appliedAt,
      selections: selected.map((s) => ({ findingId: s.findingId, patchId: s.patchId })),
      before: toSnapshot(productId, items, appliedAt),
      afterItems: applied.items,
      beforeAuditRunId,
    });

    // 반영 뒤 전 규칙 재검수 1회 (FR-PA-022 · 024). 새 `audit_run` 이 생기고 이전 것은 남는다
    const { job } = await this.jobs.enqueue(productId, 'PATCH');
    this.track(this.drain());

    return {
      patchApplicationId: saved.id,
      beforeAuditRunId,
      reauditJobId: job.id,
      pollIntervalMs: POLL_INTERVAL_MS,
    };
  }

  /**
   * 있으면 주고 없으면 `null`.
   *
   * `getRun` 과 달리 던지지 않는다 — 재검수가 아직 안 끝났거나 실패한 이력은
   * `after_audit_run_id` 가 비어 있는 것이 정상이고(EX-PA-004), 그걸 404 로 만들면
   * 이력 조회 자체가 막힌다.
   */
  async findRun(auditRunId: number | null): Promise<StoredAuditRun | null> {
    return auditRunId === null ? null : this.results.findById(auditRunId);
  }

  async latestPatchApplication(productId: number): Promise<StoredPatchApplication | null> {
    return this.patchApplications.latestOf(productId);
  }

  async getPatchApplication(id: number): Promise<StoredPatchApplication> {
    const application = await this.patchApplications.findById(id);
    if (application === null) {
      throw new DomainException(HttpStatus.NOT_FOUND, 'NOT_FOUND', '패치 이력을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.', 'REQUEST');
    }
    return application;
  }

  /**
   * 되돌린다 (FR-PA-026 · EX-PA-006).
   *
   * **직전 1건만** 받는다. 두 단계 전으로 돌아가려면 그 사이 이력의 `after_snapshot` 을
   * 건너뛰어야 하는데, 그러면 중간 확정에서 사용자가 고른 선택이 소리 없이 사라진다.
   *
   * 준비도가 떨어졌다는 이유로 여기를 자동으로 부르지 않는다. 되돌릴지는 사용자가
   * 결정한다 (FR-PA-027).
   */
  async revertPatch(id: number): Promise<{ application: StoredPatchApplication; revertedAt: Date }> {
    const application = await this.getPatchApplication(id);

    if (application.revertedAt !== null) {
      throw new DomainException(
        HttpStatus.CONFLICT, 'UNDO_UNAVAILABLE',
        '이미 되돌린 패치입니다. 되돌리기는 한 번만 할 수 있습니다.', 'REQUEST',
      );
    }

    const latest = await this.patchApplications.latestOf(application.productId);
    if (latest === null || latest.id !== application.id) {
      throw new DomainException(
        HttpStatus.CONFLICT, 'UNDO_UNAVAILABLE',
        '직전에 반영한 패치만 되돌릴 수 있습니다. 이후 반영한 패치를 먼저 확인해 주세요.', 'REQUEST',
      );
    }

    const revertedAt = new Date();
    await this.patchApplications.revert(application, revertedAt);
    return { application, revertedAt };
  }

  /**
   * 선택 목록을 실제 수정안으로 바꾼다. 미리보기와 확정이 **같은 문**을 쓴다.
   *
   * 두 경로가 각자 확인하면 한쪽에만 조건이 붙는 날이 온다 — 미리보기에서 막히던 것이
   * 확정에서는 통과하는 식이다.
   */
  private async resolveSelections(
    productId: number,
    selections: readonly PatchRef[],
  ): Promise<{ items: readonly ItineraryItemRow[]; selected: readonly SelectedPatch[] }> {
    const product = await this.products.findProduct(productId);
    if (product === null) {
      throw new DomainException(HttpStatus.NOT_FOUND, 'NOT_FOUND', '상품을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.', 'PRODUCT');
    }
    if (selections.length === 0) {
      throw new DomainException(HttpStatus.BAD_REQUEST, 'PATCH_STALE', '반영할 수정안을 선택해 주세요.', 'REQUEST');
    }

    const items = await this.products.findItems(productId);
    const byFinding = await this.results.patchesOfProduct(productId, [...new Set(selections.map((s) => s.findingId))]);

    const selected: SelectedPatch[] = [];
    for (const s of selections) {
      const patch = byFinding.get(s.findingId)?.find((p) => p.patchId === s.patchId);
      if (patch === undefined) {
        /*
         * 재검수가 돌면 finding 이 새로 만들어져 이전 id 는 사라진다. 화면이 오래된
         * 목록을 들고 있었다는 뜻이라 `PATCH_STALE` 이다 — 없는 걸 조용히 빼고 나머지만
         * 반영하면 사용자는 고르지 않은 결과를 받는다.
         */
        throw new DomainException(
          HttpStatus.CONFLICT, 'PATCH_STALE',
          '검수 결과가 갱신되어 선택한 수정안을 찾을 수 없습니다. 새로 고친 뒤 다시 선택해 주세요.', 'REQUEST',
        );
      }
      selected.push({ ...patch, findingId: s.findingId });
    }
    return { items, selected };
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

  /**
   * 예산 게이트 (FR-OP-003 · 004).
   *
   * 사용자가 누른 검수는 100% 까지 허용한다 — 자동 배치와 달리 미룰 수 없기 때문이다.
   * 패치 확정도 사용자가 누른 것이라 같은 문을 쓴다.
   */
  private async assertBudget(intent: CallIntent): Promise<void> {
    const guard = new BudgetGuard({ counter: this.callLogger });
    const decision = await guard.check(intent);
    if (!decision.allowed) {
      throw new DomainException(
        HttpStatus.TOO_MANY_REQUESTS, decision.reasonCode ?? 'BUDGET_EXHAUSTED',
        '오늘 사용할 수 있는 공사 데이터 조회량을 모두 썼습니다. 내일 다시 시도하거나 관리자에게 예산 상향을 요청해 주세요.',
        'REQUEST',
      );
    }
  }

  private track(promise: Promise<void>): void {
    const wrapped = promise.finally(() => this.inFlight.delete(wrapped));
    this.inFlight.add(wrapped);
  }

  /**
   * 길찾기 클라이언트를 만든다. **실패해도 던지지 않는다.**
   *
   * 카카오 키가 없다고 검수 전체가 죽으면 안 된다. R08 만 확인 불가로 남고 나머지 규칙은
   * 그대로 판정한다 (EI-KM-009). 대신 무슨 일이 있었는지는 로그에 남긴다.
   */
  private buildKakaoClient(): KakaoMobilityClient | undefined {
    try {
      return new KakaoMobilityClient({ transport: createKakaoTransport(), logger: this.callLogger });
    } catch (e) {
      this.logger.warn(`길찾기 클라이언트를 만들지 못했다. R08 은 확인 불가로 처리된다: ${(e as Error).message}`);
      return undefined;
    }
  }

  /**
   * 기상청 클라이언트를 만든다. **실패해도 던지지 않는다.**
   *
   * 길찾기와 같은 이유다 — 예보 키가 없다고 검수 전체가 죽으면 안 된다. R09 만 확인
   * 불가로 남는다 (EI-WX-006).
   */
  private buildKmaClient(): KmaClient | undefined {
    try {
      return new KmaClient({ transport: createKmaTransport(), logger: this.callLogger });
    } catch (e) {
      this.logger.warn(`기상청 클라이언트를 만들지 못했다. R09 는 확인 불가로 처리된다: ${(e as Error).message}`);
      return undefined;
    }
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
        // 이동시간 판정. 키가 없어도 검수는 돈다 — R08 만 확인 불가로 남는다 (EI-KM-009)
        kakao: this.buildKakaoClient(),
        // 우천 리스크. 평년 표가 비어 있으면 D+11 이상만 확인 불가로 남는다 (이슈 #7)
        kma: this.buildKmaClient(),
        climate: new ClimateNormalRepository(this.pool),
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

      /*
       * 재검수 결과를 이력의 오른쪽에 붙인다 (FR-PA-025 · 전후 비교).
       *
       * 확정이 부른 검수만 붙이도록 좁히지 않는다. 자동 재검수가 실패하면 이력의 오른쪽이
       * 빈 채로 남는데(EX-PA-004), 그 상태를 푸는 수단이 바로 사용자가 다시 누르는
       * 검수이기 때문이다. 좁혀 두면 한 번 실패한 이력은 영영 전후 비교를 못 한다.
       *
       * 붙일 자리가 없으면 아무 일도 하지 않는다 — 대상은 오른쪽이 비어 있고 되돌리지
       * 않은 가장 최근 이력 1건뿐이다.
       */
      await this.patchApplications.attachAfterRun(productId, auditRunId);

      await this.jobs.markDone(jobId, auditRunId, new Date());
    } catch (e) {
      /*
       * 검수가 통째로 실패해도 작업은 상태를 남긴다. 어디까지 갔는지가 사용자에게 정보다.
       * 패치 확정 뒤라면 **일정 변경은 그대로 둔다** — 자동 롤백하지 않고 재실행 수단만
       * 준다 (EX-PA-004). `after_audit_run_id` 는 비어 있고 이력 조회가 그 사실을 말한다.
       */
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

/**
 * 패치 이력 상세 (FR-PA-028) + 경고 배너 (FR-PA-027).
 *
 * 준비도가 떨어지거나 차단이 늘어도 **일정을 되돌리지 않는다.** 무엇이 나빠졌는지 적고
 * 되돌리기가 열려 있다는 것만 알린다 — 결정은 사용자가 한다 (EX-PA-005).
 *
 * 되돌릴 수 있는지는 두 가지로 정해진다. 아직 되돌리지 않았고, 그 상품의 **직전 1건**일
 * 것 (FR-PA-026). 화면이 버튼을 그릴지 판단하는 값이라 서버가 계산해 내려준다.
 */
export function toPatchApplicationResponse(
  application: StoredPatchApplication,
  before: StoredAuditRun | null,
  after: StoredAuditRun | null,
  isLatest: boolean,
): Record<string, unknown> {
  const revertible = application.revertedAt === null && isLatest;
  return {
    patchApplicationId: application.id,
    productId: application.productId,
    appliedAt: application.appliedAt.toISOString(),
    selectedPatches: application.selections,
    itemCount: { before: application.before.items.length, after: application.after.items.length },
    before: toSideSummary(application.beforeAuditRunId, before),
    after: toSideSummary(application.afterAuditRunId, after),
    // 재검수가 실패해도 일정 변경은 유지된다. 다시 돌릴 수단은 검수 요청 경로다 (EX-PA-004)
    reauditStatus: application.afterAuditRunId === null ? 'PENDING' : 'DONE',
    warningBanner: warningBanner(before, after),
    revertible,
    revertedAt: application.revertedAt === null ? null : application.revertedAt.toISOString(),
  };
}

function toSideSummary(auditRunId: number | null, run: StoredAuditRun | null): Record<string, unknown> | null {
  if (auditRunId === null) return null;
  if (run === null) return { auditRunId };
  return {
    auditRunId,
    executedAt: run.executedAt.toISOString(),
    readinessScore: run.current.score,
    counts: {
      blocker: run.current.counts.BLOCKER, error: run.current.counts.ERROR,
      warning: run.current.counts.WARNING, unverified: run.current.counts.UNVERIFIED,
    },
  };
}

/**
 * 나빠졌으면 문구를 만든다. 아니면 `null` — 좋아진 것을 배너로 알릴 이유는 없다.
 *
 * 준비도가 `null` 인 부분 검수는 비교하지 않는다. 점수 없는 실행과 점수 있는 실행을
 * 견주면 "100 → 없음" 같은 하락이 만들어진다 (DR-IN-005).
 */
function warningBanner(before: StoredAuditRun | null, after: StoredAuditRun | null): string | null {
  if (before === null || after === null) return null;

  const reasons: string[] = [];
  const b = before.current;
  const a = after.current;
  if (b.score !== null && a.score !== null && a.score < b.score) {
    reasons.push(`출시 준비도가 ${String(b.score)}점에서 ${String(a.score)}점으로 내려갔습니다`);
  }
  if (a.counts.BLOCKER > b.counts.BLOCKER) {
    reasons.push(`차단이 ${String(b.counts.BLOCKER)}건에서 ${String(a.counts.BLOCKER)}건으로 늘었습니다`);
  }
  if (reasons.length === 0) return null;
  return `${reasons.join('. ')}. 일정은 그대로 두었습니다. 되돌리거나 이대로 진행할지 선택해 주세요.`;
}

export function toRevertResponse(application: StoredPatchApplication, revertedAt: Date): Record<string, unknown> {
  return {
    patchApplicationId: application.id,
    productId: application.productId,
    revertedAt: revertedAt.toISOString(),
    /*
     * 되돌린 일정은 `before_audit_run_id` 가 판정한 그 일정이다. 재검수를 다시 돌리지
     * 않고 그 결과를 현재 결과로 가리킨다 — 같은 답을 받으려고 공사 호출을 쓰지 않는다.
     */
    restoredAuditRunId: application.beforeAuditRunId,
  };
}
