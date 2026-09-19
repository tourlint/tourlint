import { Controller, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';
import { CurrentAccount } from '../auth/current-account.decorator';
import type { SessionAccount } from '../auth/session.repository';
import { CheckQuestionService } from './check-question.service';

/**
 * 검수 에이전트 (F18 · API 4-11).
 *
 * 사람이 \[전화로 물어볼 내용 정리\]를 누를 때만 돈다. 판정하지 않는다 — \[확인했어요\]는
 * 사람이 누르는 기존 API 다 (FR-AG-022).
 */
@Controller('api/v1/audit-runs')
export class CheckQuestionController {
  constructor(private readonly service: CheckQuestionService) {}

  @Post(':runId/check-questions')
  @HttpCode(200)
  async questions(
    @CurrentAccount() account: SessionAccount,
    @Param('runId', ParseIntPipe) runId: number,
  ): Promise<Record<string, unknown>> {
    return { ...(await this.service.questions(account.accountId, runId)) };
  }
}
