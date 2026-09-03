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

/** R10 기대 콘텐츠 프로파일 한 줄 — (타깃·콘셉트) → 기대 중분류 목록 (가변 행). */
export interface ProfileEntry {
  targetKey: string;
  conceptKey: string;
  expectedLcls2: string[];
  expectsNight: boolean;
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

  /** R10 프로파일 목록 (계정이 정의한 것). */
  async profiles(accountId: number): Promise<ProfileEntry[]> {
    const { rows } = await this.pool.query<{
      target_key: string;
      concept_key: string;
      expected_lcls2: string[];
      expects_night: boolean;
    }>(
      `SELECT target_key, concept_key, expected_lcls2, expects_night
         FROM target_profile WHERE account_id = $1 ORDER BY target_key, concept_key`,
      [accountId],
    );
    return rows.map((r) => ({
      targetKey: r.target_key,
      conceptKey: r.concept_key,
      expectedLcls2: r.expected_lcls2,
      expectsNight: r.expects_night,
    }));
  }

  /**
   * 프로파일 전체 교체. 화면이 보낸 집합으로 계정 프로파일을 통째로 바꾼다.
   *
   * 가변 행이라 upsert 로는 삭제를 표현할 수 없다 — 지운 프로파일을 반영하려면 전체를
   * 다시 써야 한다. 삭제·삽입을 한 트랜잭션으로 묶어 중간 상태가 판정에 새지 않게 한다.
   */
  async saveProfiles(accountId: number, entries: ProfileEntry[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM target_profile WHERE account_id = $1`, [accountId]);
      for (const e of entries) {
        await client.query(
          `INSERT INTO target_profile (account_id, target_key, concept_key, expected_lcls2, expects_night)
           VALUES ($1, $2, $3, $4, $5)`,
          [accountId, e.targetKey, e.conceptKey, e.expectedLcls2, e.expectsNight],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

/** 알려진 중분류인지 — 편집 입력 검증용. dwell 은 47종, io 는 59종이 시드다. */
export const KNOWN_DWELL_LCLS = new Set(Object.keys(DWELL_MINUTES_SEED));
export const KNOWN_IO_LCLS = new Set(Object.keys(INDOOR_OUTDOOR_SEED));
/** 전체 중분류 59종 — R10 기대 중분류 입력 검증용. */
export const KNOWN_LCLS = new Set(Object.keys(LCLS_SYSTM2));
