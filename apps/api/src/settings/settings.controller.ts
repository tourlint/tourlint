import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentAccount } from '../auth/current-account.decorator';
import type { SessionAccount } from '../auth/session.repository';
import { SettingsService, type SettingsView } from './settings.service';

/**
 * 관리자 설정 (F16 · FR-OP-020~027 · UI-S8).
 *
 * 계정 설정(가중치 · R07 · R04 · 관심 키워드)은 요청 계정 것만 조회·저장한다 (PM-DA-005).
 * 전역 설정(배치 실행 시각 · 일일 호출 예산)은 서비스 전체 공통이라 여기서는 조회만 준다 —
 * 전역 변경은 관리자 권한 체계가 서야 열 수 있다.
 *
 * R10 기대 콘텐츠 프로파일 · 중분류 체류시간 · 실내 · 야외 매핑(59행 표 3종)은 별도 편집
 * 경로로 다룬다 (후속).
 */
@ApiTags('실엔진')
@Controller('api/v1')
export class SettingsController {
  constructor(private readonly service: SettingsService) {}

  @Get('settings')
  async get(@CurrentAccount() account: SessionAccount): Promise<SettingsView> {
    return this.service.get(account.accountId, account.isDemo);
  }

  @Put('settings')
  async update(
    @CurrentAccount() account: SessionAccount,
    @Body() body: unknown,
  ): Promise<SettingsView> {
    return this.service.updateAccount(account.accountId, account.isDemo, body);
  }

  /**
   * 전역 설정(배치 시각 · 일일 예산) 저장. 서비스 전체에 적용된다. 데모 계정은 403 이다.
   * 관리자 롤 체계가 서면 여기에 그 인가를 건다.
   */
  @Put('settings/global')
  async updateGlobal(
    @CurrentAccount() account: SessionAccount,
    @Body() body: unknown,
  ): Promise<SettingsView> {
    return this.service.updateGlobal(account.accountId, account.isDemo, body);
  }
}
