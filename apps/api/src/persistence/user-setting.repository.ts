import type { Pool } from 'pg';
import { COMPANY_SETTING_LIMITS } from '@tourlint/shared';
import { DEFAULT_AUDIT_SETTINGS, type AuditSettings } from '../engine/rules/types';

/**
 * 판정에 쓰는 계정 설정을 읽는다 (`user_setting`).
 *
 * **계정이 바꿀 수 있는 것은 R07 두 값(회사 기준)뿐이다** (FR-OP-021 · 022). 가중치 · R04 임계 ·
 * R10 프로파일 · 체류시간 · 실내 · 야외는 모든 계정이 같은 표준이라 `@tourlint/shared` 시드를
 * 읽고, 계정 표(`target_profile` · `dwell_default` · `indoor_outdoor_map`)와
 * `user_setting.weights` · `r04_threshold` 는 읽지 않는다 — 릴리즈 2 에서 지운다.
 * 변경은 다음 검수부터 적용되고 과거 결과를 소급하지 않는다 (FR-OP-026).
 *
 * **읽지 못하면 기본값으로 돌아간다.** 설정을 못 읽었다고 검수를 세우지 않는다 — 그러면
 * DB 가 잠깐 흔들릴 때 검수 전체가 멈춘다. 대신 무엇을 못 읽었는지는 호출자가 로그로 남긴다.
 */
export class UserSettingRepository {
  constructor(private readonly pool: Pool) {}

  async find(accountId: number): Promise<AuditSettings> {
    const { rows } = await this.pool.query<{ r07_span_hours: number | null; r07_meal_minutes: number | null }>(
      `SELECT r07_span_hours, r07_meal_minutes FROM user_setting WHERE account_id = $1`,
      [accountId],
    );
    const row = rows[0];
    if (row === undefined) return DEFAULT_AUDIT_SETTINGS;
    return {
      ...DEFAULT_AUDIT_SETTINGS,
      ...stricterOnly(row.r07_span_hours, row.r07_meal_minutes),
    };
  }
}

/**
 * 회사 기준은 표준보다 **엄격하게만** 쓴다 (DR-CF-008).
 *
 * 설정 API 가 느슨한 값을 거부하지만, DB CHECK 를 1 – 6시간 · 60 – 240분으로 조이는 것은
 * 릴리즈 2 다. 그 전에 저장된 8시간 · 45분 같은 값이 남아 있을 수 있어 읽을 때도 표준으로
 * 되돌린다 — 표준보다 느슨하게 판정한 결과가 「TourLint 표준 검수」로 나가면 안 된다.
 */
function stricterOnly(
  spanHours: number | null,
  mealMinutes: number | null,
): Pick<AuditSettings, 'r07SpanHours' | 'r07MealMinutes'> {
  const span = spanHours ?? COMPANY_SETTING_LIMITS.r07SpanHoursMax;
  const meal = mealMinutes ?? COMPANY_SETTING_LIMITS.r07MealMinutesMin;
  return {
    r07SpanHours: Math.min(span, COMPANY_SETTING_LIMITS.r07SpanHoursMax),
    r07MealMinutes: Math.max(meal, COMPANY_SETTING_LIMITS.r07MealMinutesMin),
  };
}
