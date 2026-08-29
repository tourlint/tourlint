import { Controller, Get, HttpCode, Param, ParseIntPipe, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentAccount } from '../auth/current-account.decorator';
import type { SessionAccount } from '../auth/session.repository';
import { ReportService } from './report.service';

/**
 * 검수 리포트 PDF (F11 · API 설계 4-7).
 *
 * 두 경로 다 **소유자 전용**이다. `AuthGuard` 가 전역이라 로그인은 이미 강제되고, 여기서는
 * 그 계정의 것인지까지 본다 (PM-DA-007). 공개 링크를 발급하는 경로는 만들지 않는다.
 */
@ApiTags('실엔진')
@Controller('api/v1')
export class ReportController {
  constructor(private readonly service: ReportService) {}

  /**
   * 만든다. 201 + `reportId` (API 설계 4-7).
   *
   * 렌더까지 끝내고 돌려준다 — 202 로 받아 두고 뒤에서 만들면 진행 상태를 물어볼 곳이
   * 필요한데, `report` 테이블이 없어 작업 상태를 남길 자리가 없다. NF-PF-006 이 p95 10초라
   * 요청을 붙잡고 있어도 되는 길이다.
   */
  @Post('audit-runs/:runId/reports')
  @HttpCode(201)
  async create(
    @CurrentAccount() account: SessionAccount,
    @Param('runId', ParseIntPipe) runId: number,
  ): Promise<Record<string, unknown>> {
    return { ...(await this.service.create(runId, account.accountId)) };
  }

  /**
   * 내려받는다. 인증 필수 (PM-DA-007).
   *
   * 파일을 서버에 두지 않는다 — 메모리에 있는 것을 그대로 흘려보내고 끝이다
   * (DB 명세서 6-4). 캐시도 막는다. 중간 프록시에 남으면 그것도 원문 저장소다.
   */
  @Get('reports/:reportId/download')
  download(
    @CurrentAccount() account: SessionAccount,
    @Param('reportId') reportId: string,
    @Res() res: Response,
  ): void {
    const report = this.service.download(reportId, account.accountId);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(report.pdf.length),
      // 파일명이 한글이라 RFC 5987 로 함께 준다. filename 만 주면 브라우저가 깨뜨린다
      'Content-Disposition':
        `attachment; filename="report.pdf"; filename*=UTF-8''${encodeURIComponent(report.fileName)}`,
      'Cache-Control': 'no-store, private',
    });
    res.send(report.pdf);
  }
}
