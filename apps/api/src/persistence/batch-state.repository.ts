import type { Pool } from 'pg';
import { SYSTEM_SETTING_DEFAULTS } from '@tourlint/shared';

/**
 * 배치 상태와 전역 운영 설정 (`batch_state` · `system_setting` · F12 · DR-CF-005 · 007).
 *
 * 배치 시각 · 활성화 · 일일 예산은 **계정별이 아니라 서비스 전체 값**이다 (FR-MO-010 ·
 * PM-DA-006). 예산도 단일 인증키를 함께 쓰므로 계정별로 나눌 수가 없다.
 */

export const BATCH_KEY = 'sync' as const;

export interface BatchState {
  /** 마지막으로 처리한 기준일 (`YYYY-MM-DD`). 없으면 아직 한 번도 안 돌았다 */
  readonly lastCovered: string | null;
  readonly lastRunAt: Date | null;
  readonly lastStatus: BatchStatus | null;
  readonly lastItemCount: number | null;
}

export const BATCH_STATUS = ['OK', 'EMPTY', 'FAILED', 'HIDDEN_OVERFLOW'] as const;
export type BatchStatus = (typeof BATCH_STATUS)[number];

export interface SystemSetting {
  /** `HH:MM` */
  readonly batchTime: string;
  readonly batchEnabled: boolean;
  readonly dailyQuota: number;
}

export class BatchStateRepository {
  constructor(private readonly pool: Pool) {}

  async find(key: string = BATCH_KEY): Promise<BatchState> {
    const { rows } = await this.pool.query<{
      last_covered: Date | string | null; last_run_at: Date | null;
      last_status: BatchStatus | null; last_item_count: number | null;
    }>(
      `SELECT last_covered, last_run_at, last_status, last_item_count
         FROM batch_state WHERE key = $1`,
      [key],
    );
    const row = rows[0];
    if (row === undefined) {
      return { lastCovered: null, lastRunAt: null, lastStatus: null, lastItemCount: null };
    }
    return {
      lastCovered: row.last_covered === null ? null : toIsoDate(row.last_covered),
      lastRunAt: row.last_run_at,
      lastStatus: row.last_status,
      lastItemCount: row.last_item_count,
    };
  }

  /**
   * 실행 결과를 남긴다.
   *
   * **`lastCovered` 는 성공했을 때만 넘긴다** (FR-MO-014 · DR-CF-005). 실패나 0건에도
   * 갱신하면 그 날짜의 변경을 영영 못 본다 — 다음 배치가 그 다음 날부터 보기 때문이다.
   * `undefined` 면 기존 값을 그대로 둔다.
   */
  async record(result: {
    status: BatchStatus;
    itemCount: number;
    ranAt: Date;
    lastCovered?: string;
    key?: string;
  }): Promise<void> {
    const key = result.key ?? BATCH_KEY;
    await this.pool.query(
      `INSERT INTO batch_state (key, last_covered, last_run_at, last_status, last_item_count)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key) DO UPDATE SET
         -- COALESCE 로 「안 준 경우」와 「NULL 로 지우는 경우」를 가른다
         last_covered    = COALESCE(EXCLUDED.last_covered, batch_state.last_covered),
         last_run_at     = EXCLUDED.last_run_at,
         last_status     = EXCLUDED.last_status,
         last_item_count = EXCLUDED.last_item_count`,
      [key, result.lastCovered ?? null, result.ranAt, result.status, result.itemCount],
    );
  }

  /** 전역 운영 설정. 행이 없으면 기본값이다 */
  async setting(): Promise<SystemSetting> {
    const { rows } = await this.pool.query<{
      batch_time: string; batch_enabled: boolean; daily_quota: number;
    }>(`SELECT batch_time, batch_enabled, daily_quota FROM system_setting WHERE key = 'global'`);
    const row = rows[0];
    if (row === undefined) {
      return {
        batchTime: SYSTEM_SETTING_DEFAULTS.batchTime,
        batchEnabled: SYSTEM_SETTING_DEFAULTS.batchEnabled,
        dailyQuota: SYSTEM_SETTING_DEFAULTS.dailyQuota,
      };
    }
    // `TIME` 은 `HH:MM:SS` 로 온다. 설정 화면은 분까지만 쓴다
    return {
      batchTime: String(row.batch_time).slice(0, 5),
      batchEnabled: row.batch_enabled,
      dailyQuota: row.daily_quota,
    };
  }
}

/** `DATE` 는 드라이버 설정에 따라 `Date` 로도 문자열로도 온다 */
function toIsoDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  // 한국 시간 기준 날짜다. UTC 로 읽으면 하루 밀린다
  return new Date(value.getTime() + 9 * 60 * 60_000).toISOString().slice(0, 10);
}
