import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentAccount } from '../auth/current-account.decorator';
import type { SessionAccount } from '../auth/session.repository';
import { SettingsService, type SettingsView } from './settings.service';

/**
 * 검수 기준 (F16 · FR-OP-020~027 · UI-S8).
 *
 * 계정이 바꾸는 것은 회사 기준(R07 두 값)과 관심 키워드 · 관심 지역뿐이고, 요청 계정 것만
 * 조회·저장한다 (PM-DA-005). 표준(가중치 · R04 · 표 3종)은 모든 계정에 같아 화면이 shared
 * 시드를 직접 읽고, 배치 시각 · 예산은 운영자 전용이라 조회에 다음 배치 시각만 실린다.
 */
@ApiTags('실엔진')
@Controller('api/v1')
export class SettingsController {
  constructor(private readonly service: SettingsService) {}

  @Get('settings')
  async get(@CurrentAccount() account: SessionAccount): Promise<SettingsView> {
    return this.service.get(account.accountId);
  }

  @Put('settings')
  async update(
    @CurrentAccount() account: SessionAccount,
    @Body() body: unknown,
  ): Promise<SettingsView> {
    return this.service.update(account.accountId, body);
  }
}
