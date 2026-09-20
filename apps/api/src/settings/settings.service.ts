import { BadRequestException, HttpStatus } from '@nestjs/common';
import {
  COMPANY_SETTING_LIMITS,
  SETTING_DEFAULTS,
  SEVERITY_WEIGHT_DEFAULT,
  STANDARD_VERSION, kstIso,} from '@tourlint/shared';
import { nextBatchAt } from '../batch/sync-window';
import { DomainException } from '../common/domain.exception';
import {
  type CompanySettings,
  type GlobalSettings,
  type R07HistoryEntry,
  SettingsRepository,
  type WatchRegion,
} from './settings.repository';
import { validateCompanyUpdate } from './settings.dto';

/**
 * 검수 기준 화면이 읽는 모양 (API 4-9).
 *
 * `standard` 는 모든 계정에 같은 표준(버전 · 가중치 · R04 임계치 · R07 표준값)이고 화면은
 * 읽기만 한다. `company` 는 계정이 표준보다 엄격하게 정한 R07 두 값과 변경 이력이다.
 * `ops` 는 운영자 값 중 사용자에게 보이는 것 — 다음 배치 시각뿐이다.
 */
export interface StandardView {
  version: string;
  weights: { BLOCKER: number; ERROR: number; WARNING: number; UNVERIFIED: number };
  r04Threshold: number;
  r07SpanHours: number;
  r07MealMinutes: number;
}

export interface CompanyView {
  r07SpanHours: number;
  r07MealMinutes: number;
  updatedAt: string | null;
  history: R07HistoryEntry[];
}

export interface SettingsView {
  standard: StandardView;
  company: CompanyView;
  watchKeywords: string[];
  watchRegions: WatchRegion[];
  ops: { batchTime: string; nextBatchAt: string | null };
}

export class SettingsService {
  constructor(private readonly repo: SettingsRepository) {}

  async get(accountId: number): Promise<SettingsView> {
    const [company, global] = await Promise.all([this.repo.company(accountId), this.repo.global()]);
    return this.toView(company, global);
  }

  /**
   * 회사 기준 · 관심 값 저장. 회사 기준이 표준보다 느슨하면 400 `SETTING_NOT_STRICTER`,
   * 그 밖의 형식 오류는 400 + 문구. 바꾼 회사 기준은 변경 이력에 남고 다음 검수부터 적용된다
   * — 과거 점수는 소급 변경하지 않는다 (FR-OP-022 · 026 · DR-CF-008).
   */
  async update(accountId: number, body: unknown): Promise<SettingsView> {
    const { errors, notStricter, patch } = validateCompanyUpdate(body as Record<string, unknown> | undefined);
    if (notStricter) {
      throw new DomainException(
        HttpStatus.BAD_REQUEST,
        'SETTING_NOT_STRICTER',
        `회사 기준은 표준보다 엄격하게만 정할 수 있습니다 — 연속 일정은 ${COMPANY_SETTING_LIMITS.r07SpanHoursMax}시간 이하, 식사는 ${COMPANY_SETTING_LIMITS.r07MealMinutesMin}분 이상으로 맞춰 주세요.`,
      );
    }
    if (errors.length > 0) throw new BadRequestException(errors.join(' '));
    const saved = await this.repo.saveCompany(accountId, patch, kstIso(new Date()));
    const global = await this.repo.global();
    return this.toView(saved, global);
  }

  private toView(company: CompanySettings, global: GlobalSettings): SettingsView {
    return {
      standard: {
        version: STANDARD_VERSION,
        weights: { ...SEVERITY_WEIGHT_DEFAULT },
        r04Threshold: SETTING_DEFAULTS.r04Threshold,
        r07SpanHours: SETTING_DEFAULTS.r07SpanHours,
        r07MealMinutes: SETTING_DEFAULTS.r07MealMinutes,
      },
      company: {
        r07SpanHours: company.r07SpanHours,
        r07MealMinutes: company.r07MealMinutes,
        updatedAt: company.updatedAt,
        history: company.history,
      },
      watchKeywords: company.watchKeywords,
      watchRegions: company.watchRegions,
      ops: {
        batchTime: global.batchTime,
        nextBatchAt: nextBatchAt(new Date(), global.batchTime, global.batchEnabled),
      },
    };
  }
}
