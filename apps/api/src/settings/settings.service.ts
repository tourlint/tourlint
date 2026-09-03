import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  ACCOUNT_SETTING_DEFAULTS,
  GLOBAL_QUOTA_CAP,
  GLOBAL_SETTING_DEFAULTS,
  type AccountSettings,
  type GlobalSettings,
  SettingsRepository,
} from './settings.repository';
import { validateAccountSettings, validateGlobal } from './settings.dto';

export interface SettingsView {
  account: AccountSettings;
  global: GlobalSettings;
  // 기본값 복원용 (UI-S8-003). 전역 값은 서비스 전체 공통이라 라벨과 함께 화면이 구분한다.
  defaults: { account: AccountSettings; global: GlobalSettings };
  // 전역 편집 권한·예산 상한 (UI-S8-006). 데모 계정은 전역을 못 바꾼다.
  globalEditable: boolean;
  quotaCap: number;
}

export class SettingsService {
  constructor(private readonly repo: SettingsRepository) {}

  async get(accountId: number, isDemo: boolean): Promise<SettingsView> {
    const [account, global] = await Promise.all([this.repo.accountSettings(accountId), this.repo.global()]);
    return {
      account,
      global,
      defaults: { account: ACCOUNT_SETTING_DEFAULTS, global: GLOBAL_SETTING_DEFAULTS },
      globalEditable: !isDemo,
      quotaCap: GLOBAL_QUOTA_CAP,
    };
  }

  /** 계정 설정만 저장한다. 전역 값(배치 시각 · 일일 예산)은 이 경로로 바꾸지 않는다. */
  async updateAccount(accountId: number, isDemo: boolean, body: unknown): Promise<SettingsView> {
    const { errors, settings } = validateAccountSettings(body as Record<string, unknown> | undefined);
    if (settings === undefined) throw new BadRequestException(errors.join(' '));
    await this.repo.saveAccount(accountId, settings);
    return this.get(accountId, isDemo);
  }

  /**
   * 전역 설정 저장. 서비스 전체에 적용되므로 데모 계정은 막는다 (PM-TA · FR-OP-021).
   *
   * 관리자 롤 체계가 없어 지금은 데모 여부로만 가른다 — 비데모 계정이면 바꿀 수 있다.
   * 진짜 관리자 인가는 후속 과제다.
   */
  async updateGlobal(accountId: number, isDemo: boolean, body: unknown): Promise<SettingsView> {
    if (isDemo) {
      throw new ForbiddenException('데모 계정은 서비스 전체 설정을 바꿀 수 없습니다.');
    }
    const { errors, settings } = validateGlobal(body as Record<string, unknown> | undefined);
    if (settings === undefined) throw new BadRequestException(errors.join(' '));
    await this.repo.saveGlobal(settings);
    return this.get(accountId, isDemo);
  }
}
