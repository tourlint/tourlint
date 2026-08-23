import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import {
  AuditService,
  toFindingsResponse,
  toJobResponse,
  toPatchApplicationResponse,
  toRevertResponse,
  toRunResponse,
} from './audit.service';
import { TRIGGER_TYPE, type TriggerType } from './audit-job.repository';

/**
 * 검수 실행 · 조회 (F04 ~ F07).
 *
 * mock 을 대체한 **첫 실엔진 엔드포인트 4종**이다. 교체된 mock 라우트는 즉시 제거했다 —
 * 공사 호출을 모의 응답으로 전면 대체한 채 제출하면 심사에서 제외된다 (NF-CO-002 · FR-OP-009).
 *
 * **"지금 재검수" 는 별도 엔드포인트가 아니다.** 같은 경로에 `triggerType: "MANUAL"` 로
 * 요청하며, 이 경로만 예산 100% 까지 허용된다 (API 설계 5-3).
 */
@Controller('api/v1')
export class AuditController {
  constructor(private readonly service: AuditService) {}

  /** 202 + jobId. 실제 검수는 뒤에서 돈다 (p95 500ms) */
  @Post('products/:productId/audit-jobs')
  @HttpCode(202)
  async createJob(
    @Param('productId', ParseIntPipe) productId: number,
    @Body() body: { triggerType?: string } | undefined,
  ): Promise<Record<string, unknown>> {
    const triggerType = normalizeTrigger(body?.triggerType);
    const { job } = await this.service.requestAudit(productId, triggerType);
    return toJobResponse(job, true);
  }

  /** 폴링. 화면을 벗어났다 돌아와도 jobId 로 이어서 본다 (EX-AU-003) */
  @Get('audit-jobs/:jobId')
  async job(@Param('jobId', ParseIntPipe) jobId: number): Promise<Record<string, unknown>> {
    return toJobResponse(await this.service.getJob(jobId));
  }

  @Get('audit-runs/:runId')
  async run(@Param('runId', ParseIntPipe) runId: number): Promise<Record<string, unknown>> {
    return toRunResponse(await this.service.getRun(runId));
  }

  /**
   * 고른 수정안을 반영하면 어떻게 되는지 미리 본다 (F08).
   *
   * 저장하지 않는다. 충돌이 있으면 `hasConflict` 가 참이고 쌍이 명시된다 — 확정을 막는
   * 판단은 화면이 이걸 보고 한다 (FR-PA-006).
   */
  @Post('products/:productId/patch-preview')
  @HttpCode(200)
  async patchPreview(
    @Param('productId', ParseIntPipe) productId: number,
    @Body() body: { selections?: unknown } | undefined,
  ): Promise<Record<string, unknown>> {
    return { ...(await this.service.previewPatches(productId, readSelections(body?.selections))) };
  }

  /**
   * 고른 수정안을 확정한다 (F09).
   *
   * 202 다. 일정 변경은 응답 전에 끝나 있고 **재검수만** 뒤에서 돈다 — 재검수는 8곳에
   * 15초라 요청을 붙잡고 있을 수 없다. `reauditJobId` 로 진행 상태를 따라간다.
   */
  @Post('products/:productId/patch-applications')
  @HttpCode(202)
  async applyPatches(
    @Param('productId', ParseIntPipe) productId: number,
    @Body() body: { selections?: unknown; previewToken?: unknown } | undefined,
  ): Promise<Record<string, unknown>> {
    return { ...(await this.service.confirmPatches(
      productId,
      readSelections(body?.selections),
      readPreviewToken(body?.previewToken),
    )) };
  }

  /** 패치 이력 상세 (FR-PA-028) + 경고 배너 · 되돌리기 가능 여부 (FR-PA-027) */
  @Get('patch-applications/:id')
  async patchApplication(@Param('id', ParseIntPipe) id: number): Promise<Record<string, unknown>> {
    const application = await this.service.getPatchApplication(id);
    const [before, after, latest] = await Promise.all([
      this.service.findRun(application.beforeAuditRunId),
      this.service.findRun(application.afterAuditRunId),
      this.service.latestPatchApplication(application.productId),
    ]);
    return toPatchApplicationResponse(application, before, after, latest?.id === application.id);
  }

  /** 되돌리기. 직전 1건이 아니면 409 `UNDO_UNAVAILABLE` (FR-PA-026 · EX-PA-006) */
  @Post('patch-applications/:id/revert')
  @HttpCode(200)
  async revert(@Param('id', ParseIntPipe) id: number): Promise<Record<string, unknown>> {
    const { application, revertedAt } = await this.service.revertPatch(id);
    return toRevertResponse(application, revertedAt);
  }

  @Get('audit-runs/:runId/findings')
  async findings(
    @Param('runId', ParseIntPipe) runId: number,
    @Query('severity') severity?: string,
  ): Promise<Record<string, unknown>> {
    return toFindingsResponse(await this.service.getRun(runId), severity);
  }
}

/**
 * 선택 목록을 읽는다.
 *
 * 모양이 아닌 것은 **버리지 않고 튕긴다.** 조용히 걸러 내면 사용자가 고른 수정안 하나가
 * 사라진 채로 반영되고, 화면은 다 반영된 줄 안다 (FR-PA-008 의 취지).
 */
function readSelections(raw: unknown): readonly { findingId: number; patchId: string }[] {
  /*
   * 사유코드 39종에 요청 형식용 코드가 없다. 없는 코드를 지어내는 대신, 잘못된 경로
   * 파라미터를 `ParseIntPipe` 가 다루는 방식과 같이 400 으로 튕긴다.
   */
  if (!Array.isArray(raw)) throw new BadRequestException('반영할 수정안 목록이 필요합니다.');
  return raw.map((entry) => {
    const e = entry as { findingId?: unknown; patchId?: unknown };
    if (!Number.isInteger(e.findingId) || typeof e.patchId !== 'string' || e.patchId === '') {
      throw new BadRequestException('수정안 선택은 findingId 와 patchId 로 지정해 주세요.');
    }
    return { findingId: e.findingId as number, patchId: e.patchId };
  });
}

/**
 * 미리보기 토큰을 읽는다. 없으면 `null` — 확정 경로가 "일정이 바뀌었는가" 검사만 건너뛴다.
 *
 * 모양이 아닌 값은 없는 것으로 치지 않고 튕긴다. 오타 난 토큰을 조용히 무시하면 그
 * 요청만 검사 없이 통과한다.
 */
function readPreviewToken(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || raw === '') {
    throw new BadRequestException('previewToken 은 미리보기 응답의 문자열 그대로 보내 주세요.');
  }
  return raw;
}

/** 지정하지 않으면 최초 검수로 본다. 알 수 없는 값은 조용히 무시하지 않고 기본값으로 떨어뜨린다 */
function normalizeTrigger(value: string | undefined): TriggerType {
  return TRIGGER_TYPE.includes(value as TriggerType) ? (value as TriggerType) : 'INITIAL';
}
