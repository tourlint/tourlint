import { BadRequestException } from '@nestjs/common';
import {
  ACCOUNT_SETTING_DEFAULTS,
  GLOBAL_SETTING_DEFAULTS,
  type AccountSettings,
  type GlobalSettings,
  SettingsRepository,
} from './settings.repository';
import { validateAccountSettings } from './settings.dto';

export interface SettingsView {
  account: AccountSettings;
  global: GlobalSettings;
  // 기본값 복원용 (UI-S8-003). 전역 값은 서비스 전체 공통이라 라벨과 함께 화면이 구분한다.
  defaults: { account: AccountSettings; global: GlobalSettings };
}

export class SettingsService {
  constructor(private readonly repo: SettingsRepository) {}

  async get(accountId: number): Promise<SettingsView> {
    const [account, global] = await Promise.all([this.repo.accountSettings(accountId), this.repo.global()]);
    return { account, global, defaults: { account: ACCOUNT_SETTING_DEFAULTS, global: GLOBAL_SETTING_DEFAULTS } };
  }

  /** 계정 설정만 저장한다. 전역 값(배치 시각 · 일일 예산)은 이 경로로 바꾸지 않는다. */
  async updateAccount(accountId: number, body: unknown): Promise<SettingsView> {
    const { errors, settings } = validateAccountSettings(body as Record<string, unknown> | undefined);
    if (settings === undefined) throw new BadRequestException(errors.join(' '));
    await this.repo.saveAccount(accountId, settings);
    return this.get(accountId);
  }
}
