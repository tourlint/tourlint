import type { Pool } from 'pg';
import { DWELL_MINUTES_SEED, INDOOR_OUTDOOR_SEED, SETTING_DEFAULTS, type IndoorOutdoor } from '@tourlint/shared';
import { DEFAULT_AUDIT_SETTINGS, type AuditSettings } from '../engine/rules/types';

/**
 * 판정에 쓰는 계정 설정을 읽는다 (`user_setting` · `indoor_outdoor_map` · `dwell_default`).
 *
 * 규칙이 상수를 직접 읽지 않는 이유가 여기 있다 — 설정 화면에서 조정할 수 있어야 하고
 * (FR-RU-072 · FR-OP-021), 계정마다 다를 수 있다. 변경은 다음 검수부터 적용되고 과거
 * 결과를 소급하지 않는다 (FR-OP-026).
 *
 * **읽지 못하면 기본값으로 돌아간다.** 설정을 못 읽었다고 검수를 세우지 않는다 — 그러면
 * DB 가 잠깐 흔들릴 때 검수 전체가 멈춘다. 대신 무엇을 못 읽었는지는 호출자가 로그로 남긴다.
 */
export class UserSettingRepository {
  constructor(private readonly pool: Pool) {}

  async find(accountId: number): Promise<AuditSettings> {
    const [base, indoorOutdoor, dwell] = await Promise.all([
      this.readBase(accountId),
      this.readIndoorOutdoor(accountId),
      this.readDwell(accountId),
    ]);
    return { ...base, r09IndoorOutdoor: indoorOutdoor, dwellMinutes: dwell };
  }

  private async readBase(accountId: number): Promise<Omit<AuditSettings, 'r09IndoorOutdoor' | 'dwellMinutes'>> {
    const { rows } = await this.pool.query<{
      r07_span_hours: number; r07_meal_minutes: number; r04_threshold: number;
    }>(
      `SELECT r07_span_hours, r07_meal_minutes, r04_threshold FROM user_setting WHERE account_id = $1`,
      [accountId],
    );
    const row = rows[0];
    if (row === undefined) return DEFAULT_AUDIT_SETTINGS;
    return {
      r07SpanHours: row.r07_span_hours ?? SETTING_DEFAULTS.r07SpanHours,
      r07MealMinutes: row.r07_meal_minutes ?? SETTING_DEFAULTS.r07MealMinutes,
      r04Threshold: row.r04_threshold ?? SETTING_DEFAULTS.r04Threshold,
      // 키워드 → 분류코드 표가 아직 없다. 기제만 준비돼 있다 (FR-RU-042)
      r04ExcludedKeys: [],
    };
  }

  /**
   * 표가 비어 있으면 **상수로 돌아간다.**
   *
   * 빈 매핑을 그대로 쓰면 R09 가 모든 항목을 「매핑 없음」으로 보고 야외 비중을 못 세
   * 상품 전체가 확인 불가가 된다. 계정 기본 데이터가 안 들어간 것이 판정 결과로
   * 새어 나가면 안 된다.
   */
  private async readIndoorOutdoor(accountId: number): Promise<Readonly<Record<string, IndoorOutdoor>>> {
    const { rows } = await this.pool.query<{ lcls_systm2: string; space_type: IndoorOutdoor }>(
      `SELECT lcls_systm2, space_type FROM indoor_outdoor_map WHERE account_id = $1`,
      [accountId],
    );
    if (rows.length === 0) return INDOOR_OUTDOOR_SEED;
    return Object.fromEntries(rows.map((r) => [r.lcls_systm2, r.space_type]));
  }

  private async readDwell(accountId: number): Promise<Readonly<Record<string, number>>> {
    const { rows } = await this.pool.query<{ lcls_systm2: string; minutes: number }>(
      `SELECT lcls_systm2, minutes FROM dwell_default WHERE account_id = $1`,
      [accountId],
    );
    if (rows.length === 0) return DWELL_MINUTES_SEED;
    return Object.fromEntries(rows.map((r) => [r.lcls_systm2, r.minutes]));
  }
}
