import type { Pool } from 'pg';
import { SETTING_DEFAULTS, SEVERITY_WEIGHT_DEFAULT, SYSTEM_SETTING_DEFAULTS } from '@tourlint/shared';

/**
 * 설정 관리 저장소 (F16 · user_setting · system_setting).
 *
 * 판정용 읽기는 UserSettingRepository 가 따로 한다 — 여기는 **설정 화면의 조회·저장** 전용이다.
 * 계정 설정은 계정 단위로 격리한다 (FR-OP-021 · PM-DA-005). 전역 설정(배치 시각 · 일일 예산)은
 * 서비스 전체 공통값이라 계정에 매이지 않는다.
 */

export interface AccountSettings {
  weights: { BLOCKER: number; ERROR: number; WARNING: number; UNVERIFIED: number };
  r07SpanHours: number;
  r07MealMinutes: number;
  r04Threshold: number;
  watchKeywords: string[];
}

export interface GlobalSettings {
  batchTime: string;
  batchEnabled: boolean;
  dailyQuota: number;
}

export const ACCOUNT_SETTING_DEFAULTS: AccountSettings = {
  weights: { ...SEVERITY_WEIGHT_DEFAULT },
  r07SpanHours: SETTING_DEFAULTS.r07SpanHours,
  r07MealMinutes: SETTING_DEFAULTS.r07MealMinutes,
  r04Threshold: SETTING_DEFAULTS.r04Threshold,
  watchKeywords: [],
};

export const GLOBAL_SETTING_DEFAULTS: GlobalSettings = { ...SYSTEM_SETTING_DEFAULTS };

interface AccountRow {
  weights: AccountSettings['weights'];
  r07_span_hours: number;
  r07_meal_minutes: number;
  r04_threshold: number;
  watch_keywords: string[];
}

export class SettingsRepository {
  constructor(private readonly pool: Pool) {}

  /** 계정 설정. 행이 없으면 기본값을 그대로 돌려준다 (아직 저장한 적 없는 계정). */
  async accountSettings(accountId: number): Promise<AccountSettings> {
    const { rows } = await this.pool.query<AccountRow>(
      `SELECT weights, r07_span_hours, r07_meal_minutes, r04_threshold, watch_keywords
         FROM user_setting WHERE account_id = $1`,
      [accountId],
    );
    const row = rows[0];
    if (row === undefined) return ACCOUNT_SETTING_DEFAULTS;
    return {
      weights: row.weights,
      r07SpanHours: row.r07_span_hours,
      r07MealMinutes: row.r07_meal_minutes,
      r04Threshold: row.r04_threshold,
      watchKeywords: row.watch_keywords,
    };
  }

  /** 계정 설정 저장 (계정당 1행 upsert). 다른 계정 것은 건드리지 않는다 (PM-DA-005). */
  async saveAccount(accountId: number, s: AccountSettings): Promise<AccountSettings> {
    await this.pool.query(
      `INSERT INTO user_setting
         (account_id, weights, r07_span_hours, r07_meal_minutes, r04_threshold, watch_keywords)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (account_id) DO UPDATE SET
         weights = EXCLUDED.weights,
         r07_span_hours = EXCLUDED.r07_span_hours,
         r07_meal_minutes = EXCLUDED.r07_meal_minutes,
         r04_threshold = EXCLUDED.r04_threshold,
         watch_keywords = EXCLUDED.watch_keywords`,
      [accountId, JSON.stringify(s.weights), s.r07SpanHours, s.r07MealMinutes, s.r04Threshold, s.watchKeywords],
    );
    return s;
  }

  /** 전역 설정. 행이 없으면 기본값. */
  async global(): Promise<GlobalSettings> {
    const { rows } = await this.pool.query<{ batch_time: string; batch_enabled: boolean; daily_quota: number }>(
      `SELECT batch_time, batch_enabled, daily_quota FROM system_setting WHERE key = 'global'`,
    );
    const row = rows[0];
    if (row === undefined) return GLOBAL_SETTING_DEFAULTS;
    return {
      batchTime: String(row.batch_time).slice(0, 5),
      batchEnabled: row.batch_enabled,
      dailyQuota: row.daily_quota,
    };
  }
}
