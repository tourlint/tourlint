import type { Pool } from 'pg';
import { DWELL_MINUTES_SEED, INDOOR_OUTDOOR_SEED, LCLS_SYSTM2, type IndoorOutdoor } from '@tourlint/shared';

/**
 * 계정 단위 기준표 편집 저장소 (F16 · dwell_default · indoor_outdoor_map).
 *
 * 두 표 다 **중분류(lcls_systm2) → 값** 형태다. 계정 행이 없는 중분류는 시드 상수로
 * 돌아간다(UserSettingRepository 의 판정 읽기와 같은 규약). 편집 화면은 모든 중분류를
 * 현재값·기본값과 함께 보여야 하므로, 조회는 시드 전체에 계정 행을 덮어 돌려준다.
 */

export interface DwellEntry {
  lcls2: string;
  name: string;
  minutes: number;
  defaultMinutes: number;
}

export interface IoEntry {
  lcls2: string;
  name: string;
  spaceType: IndoorOutdoor;
  defaultSpaceType: IndoorOutdoor;
}

const nameOf = (lcls2: string): string => LCLS_SYSTM2[lcls2]?.name ?? lcls2;

export class SettingsTablesRepository {
  constructor(private readonly pool: Pool) {}

  /** 중분류별 기본 체류시간. 시드(47종) 전체에 계정 값을 덮어 돌려준다. */
  async dwell(accountId: number): Promise<DwellEntry[]> {
    const { rows } = await this.pool.query<{ lcls_systm2: string; minutes: number }>(
      `SELECT lcls_systm2, minutes FROM dwell_default WHERE account_id = $1`,
      [accountId],
    );
    const account = new Map(rows.map((r) => [r.lcls_systm2, r.minutes]));
    return Object.entries(DWELL_MINUTES_SEED)
      .map(([lcls2, seed]) => ({
        lcls2,
        name: nameOf(lcls2),
        minutes: account.get(lcls2) ?? seed,
        defaultMinutes: seed,
      }))
      .sort((a, b) => a.lcls2.localeCompare(b.lcls2));
  }

  async saveDwell(accountId: number, entries: { lcls2: string; minutes: number }[]): Promise<void> {
    if (entries.length === 0) return;
    await this.pool.query(
      `INSERT INTO dwell_default (account_id, lcls_systm2, minutes)
       SELECT $1, * FROM unnest($2::text[], $3::int[])
       ON CONFLICT (account_id, lcls_systm2) DO UPDATE SET minutes = EXCLUDED.minutes`,
      [accountId, entries.map((e) => e.lcls2), entries.map((e) => e.minutes)],
    );
  }

  /** 중분류별 실내 · 야외. 시드(59종) 전체에 계정 값을 덮어 돌려준다. */
  async indoorOutdoor(accountId: number): Promise<IoEntry[]> {
    const { rows } = await this.pool.query<{ lcls_systm2: string; space_type: IndoorOutdoor }>(
      `SELECT lcls_systm2, space_type FROM indoor_outdoor_map WHERE account_id = $1`,
      [accountId],
    );
    const account = new Map(rows.map((r) => [r.lcls_systm2, r.space_type]));
    return Object.entries(INDOOR_OUTDOOR_SEED)
      .map(([lcls2, seed]) => ({
        lcls2,
        name: nameOf(lcls2),
        spaceType: account.get(lcls2) ?? seed,
        defaultSpaceType: seed,
      }))
      .sort((a, b) => a.lcls2.localeCompare(b.lcls2));
  }

  async saveIndoorOutdoor(accountId: number, entries: { lcls2: string; spaceType: IndoorOutdoor }[]): Promise<void> {
    if (entries.length === 0) return;
    await this.pool.query(
      `INSERT INTO indoor_outdoor_map (account_id, lcls_systm2, space_type)
       SELECT $1, * FROM unnest($2::text[], $3::text[])
       ON CONFLICT (account_id, lcls_systm2) DO UPDATE SET space_type = EXCLUDED.space_type`,
      [accountId, entries.map((e) => e.lcls2), entries.map((e) => e.spaceType)],
    );
  }
}

/** 알려진 중분류인지 — 편집 입력 검증용. dwell 은 47종, io 는 59종이 시드다. */
export const KNOWN_DWELL_LCLS = new Set(Object.keys(DWELL_MINUTES_SEED));
export const KNOWN_IO_LCLS = new Set(Object.keys(INDOOR_OUTDOOR_SEED));
