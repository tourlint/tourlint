import { Controller, HttpCode, Post } from '@nestjs/common';
import { CurrentAccount } from '../auth/current-account.decorator';
import type { SessionAccount } from '../auth/session.repository';
import { TodayBriefService } from './today-brief.service';

/**
 * 레이더 에이전트 (F18 · API 4-11).
 *
 * 사람이 \[오늘 할 일 정리\]를 누를 때만 돈다. 재검수를 대신 돌리거나 기획 초안을 만들지
 * 않는다 — 할 일마다 기존 버튼이 붙는다 (FR-AG-031).
 */
@Controller('api/v1/radar')
export class TodayBriefController {
  constructor(private readonly service: TodayBriefService) {}

  @Post('today')
  @HttpCode(200)
  async today(@CurrentAccount() account: SessionAccount): Promise<Record<string, unknown>> {
    return { ...(await this.service.brief(account.accountId)) };
  }
}
