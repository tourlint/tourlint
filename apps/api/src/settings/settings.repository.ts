import type { Pool } from 'pg';
import { SETTING_DEFAULTS, SYSTEM_SETTING_DEFAULTS } from '@tourlint/shared';

/**
 * 검수 기준 저장소 (F16 · user_setting · system_setting).
 *
 * 판정용 읽기는 UserSettingRepository 가 따로 한다 — 여기는 **검수 기준 화면의 조회·저장** 전용이다.
 * 계정이 바꿀 수 있는 것은 회사 기준(R07 두 값)과 관심 키워드 · 관심 지역뿐이다 (FR-OP-021 ·
 * FR-OP-022 · PM-DA-005). 표준(가중치 · R04 임계치 · 표 3종)은 모든 계정에 같아 여기서 다루지
 * 않고 화면이 `@tourlint/shared` 시드를 직접 읽는다. 전역(배치 시각 · 일일 예산)은 운영자 전용이다.
 */

export interface WatchRegion {
  regnCd: string;
  signguCd: string | null;
  month: string;
}

/** 회사 기준 R07 변경 이력 한 줄 (FR-OP-026). 표준보다 엄격하게 바꾼 자취만 남는다. */
export interface R07HistoryEntry {
  at: string;
  field: 'r07SpanHours' | 'r07MealMinutes';
  from: number;
  to: number;
}

export interface CompanySettings {
  r07SpanHours: number;
  r07MealMinutes: number;
  updatedAt: string | null;
  history: R07HistoryEntry[];
  watchKeywords: string[];
  watchRegions: WatchRegion[];
}

/** PUT /settings 로 바꿀 수 있는 것 — 검증을 통과한 회사 기준 두 값과 관심 2종 (부분). */
export interface CompanyPatch {
  r07SpanHours?: number;
  r07MealMinutes?: number;
  watchKeywords?: string[];
  watchRegions?: WatchRegion[];
}

export interface GlobalSettings {
  batchTime: string;
  batchEnabled: boolean;
  dailyQuota: number;
}

/** 회사 기준을 아직 정한 적 없는 계정 — 표준값(6시간 · 60분)과 빈 목록. */
export const COMPANY_SETTING_DEFAULTS: CompanySettings = {
  r07SpanHours: SETTING_DEFAULTS.r07SpanHours,
  r07MealMinutes: SETTING_DEFAULTS.r07MealMinutes,
  updatedAt: null,
  history: [],
  watchKeywords: [],
  watchRegions: [],
};

export const GLOBAL_SETTING_DEFAULTS: GlobalSettings = { ...SYSTEM_SETTING_DEFAULTS };
/** 일일 호출 예산 상한 (system_setting.ck_sys_quota · DR-IN-008 운영계정 상한). */
export const GLOBAL_QUOTA_CAP = 100000;

/** 변경 이력 보관 개수. 넘으면 오래된 것부터 버린다 (개발 분담 계획 B3). */
export const R07_HISTORY_MAX = 50;

/**
 * 저장할 다음 상태를 계산한다 (순수). 바뀐 R07 값만 이력에 더하고 최근 `R07_HISTORY_MAX` 개만
 * 남긴다. 관심 값은 준 것으로 덮고, 안 준 것은 지금 값을 그대로 둔다.
 */
export function computeCompanyUpdate(current: CompanySettings, patch: CompanyPatch, at: string): CompanySettings {
  const added: R07HistoryEntry[] = [];
  if (patch.r07SpanHours !== undefined && patch.r07SpanHours !== current.r07SpanHours) {
    added.push({ at, field: 'r07SpanHours', from: current.r07SpanHours, to: patch.r07SpanHours });
  }
  if (patch.r07MealMinutes !== undefined && patch.r07MealMinutes !== current.r07MealMinutes) {
    added.push({ at, field: 'r07MealMinutes', from: current.r07MealMinutes, to: patch.r07MealMinutes });
  }
  const history = [...current.history, ...added].slice(-R07_HISTORY_MAX);
  return {
    r07SpanHours: patch.r07SpanHours ?? current.r07SpanHours,
    r07MealMinutes: patch.r07MealMinutes ?? current.r07MealMinutes,
    watchKeywords: patch.watchKeywords ?? current.watchKeywords,
    watchRegions: patch.watchRegions ?? current.watchRegions,
    history,
    // 회사 기준 변경 시각 = 마지막 R07 변경 시각. 한 번도 안 바꿨으면 null이다 —
    // 계정 생성 때 시드로 만든 행의 updated_at 을 "바꾼 적 있음"으로 오해하지 않는다.
    updatedAt: history.at(-1)?.at ?? null,
  };
}

interface CompanyRow {
  r07_span_hours: number;
  r07_meal_minutes: number;
  watch_keywords: string[];
  watch_regions: WatchRegion[];
  r07_history: R07HistoryEntry[];
}

export class SettingsRepository {
  constructor(private readonly pool: Pool) {}

  /** 회사 기준 · 관심 값. 행이 없으면 표준값과 빈 목록 (아직 정한 적 없는 계정). */
  async company(accountId: number): Promise<CompanySettings> {
    const { rows } = await this.pool.query<CompanyRow>(
      `SELECT r07_span_hours, r07_meal_minutes, watch_keywords, watch_regions, r07_history
         FROM user_setting WHERE account_id = $1`,
      [accountId],
    );
    const row = rows[0];
    if (row === undefined) return COMPANY_SETTING_DEFAULTS;
    return {
      r07SpanHours: row.r07_span_hours,
      r07MealMinutes: row.r07_meal_minutes,
      // 마지막 R07 변경 시각. 시드로 만든 행은 이력이 비어 있어 null 이다 (바꾼 적 없음).
      updatedAt: row.r07_history.at(-1)?.at ?? null,
      history: row.r07_history,
      watchKeywords: row.watch_keywords,
      watchRegions: row.watch_regions,
    };
  }

  /**
   * 회사 기준 · 관심 값 저장 (계정당 1행 upsert). 바뀐 R07 값은 변경 이력에 남긴다.
   * 다른 계정 것은 건드리지 않는다 (PM-DA-005). weights · r04_threshold 는 표준 고정이라
   * INSERT 시 컬럼 기본값에 맡긴다 — 릴리즈 2 에서 컬럼째 지운다.
   */
  async saveCompany(accountId: number, patch: CompanyPatch, at: string): Promise<CompanySettings> {
    const current = await this.company(accountId);
    const next = computeCompanyUpdate(current, patch, at);
    await this.pool.query(
      `INSERT INTO user_setting
         (account_id, r07_span_hours, r07_meal_minutes, watch_keywords, watch_regions, r07_history, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
       ON CONFLICT (account_id) DO UPDATE SET
         r07_span_hours   = EXCLUDED.r07_span_hours,
         r07_meal_minutes = EXCLUDED.r07_meal_minutes,
         watch_keywords   = EXCLUDED.watch_keywords,
         watch_regions    = EXCLUDED.watch_regions,
         r07_history      = EXCLUDED.r07_history,
         updated_at       = EXCLUDED.updated_at`,
      [accountId, next.r07SpanHours, next.r07MealMinutes, next.watchKeywords,
       JSON.stringify(next.watchRegions), JSON.stringify(next.history), at],
    );
    return next;
  }

  /** 전역 설정. 행이 없으면 기본값. 운영자 전용 — 사용자 API 로 바꾸지 않는다 (PM-FN-008). */
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

  /** 전역 설정 저장 (운영 도구용 · 한 행 key='global'). 사용자 API 경로는 없다. */
  async saveGlobal(g: GlobalSettings): Promise<GlobalSettings> {
    await this.pool.query(
      `INSERT INTO system_setting (key, batch_time, batch_enabled, daily_quota)
       VALUES ('global', $1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET
         batch_time = EXCLUDED.batch_time,
         batch_enabled = EXCLUDED.batch_enabled,
         daily_quota = EXCLUDED.daily_quota`,
      [g.batchTime, g.batchEnabled, g.dailyQuota],
    );
    return g;
  }
}
