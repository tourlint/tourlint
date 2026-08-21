import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { AuditService, toFindingsResponse, toJobResponse, toRunResponse } from './audit.service';
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

  @Get('audit-runs/:runId/findings')
  async findings(
    @Param('runId', ParseIntPipe) runId: number,
    @Query('severity') severity?: string,
  ): Promise<Record<string, unknown>> {
    return toFindingsResponse(await this.service.getRun(runId), severity);
  }
}

/** 지정하지 않으면 최초 검수로 본다. 알 수 없는 값은 조용히 무시하지 않고 기본값으로 떨어뜨린다 */
function normalizeTrigger(value: string | undefined): TriggerType {
  return TRIGGER_TYPE.includes(value as TriggerType) ? (value as TriggerType) : 'INITIAL';
}
