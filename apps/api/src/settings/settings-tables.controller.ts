import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentAccount } from '../auth/current-account.decorator';
import type { SessionAccount } from '../auth/session.repository';
import { SettingsTablesService } from './settings-tables.service';
import type { DwellEntry, IoEntry } from './settings-tables.repository';

/**
 * 계정 기준표 편집 (F16 · UI-S8-005). 중분류별 기본 체류시간 · 실내 · 야외 매핑을
 * 조회·저장한다. 계정 것만 다룬다 (PM-DA-005). JSON 직접 편집 경로는 두지 않는다 —
 * 화면이 표로 편집하고 여기로 항목 목록만 보낸다.
 */
@ApiTags('실엔진')
@Controller('api/v1')
export class SettingsTablesController {
  constructor(private readonly service: SettingsTablesService) {}

  @Get('settings/dwell')
  async dwell(@CurrentAccount() account: SessionAccount): Promise<{ entries: DwellEntry[] }> {
    return this.service.dwell(account.accountId);
  }

  @Put('settings/dwell')
  async saveDwell(
    @CurrentAccount() account: SessionAccount,
    @Body() body: unknown,
  ): Promise<{ entries: DwellEntry[] }> {
    return this.service.saveDwell(account.accountId, body);
  }

  @Get('settings/indoor-outdoor')
  async indoorOutdoor(@CurrentAccount() account: SessionAccount): Promise<{ entries: IoEntry[] }> {
    return this.service.indoorOutdoor(account.accountId);
  }

  @Put('settings/indoor-outdoor')
  async saveIndoorOutdoor(
    @CurrentAccount() account: SessionAccount,
    @Body() body: unknown,
  ): Promise<{ entries: IoEntry[] }> {
    return this.service.saveIndoorOutdoor(account.accountId, body);
  }
}
