import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DWELL_MINUTES_SEED, INDOOR_OUTDOOR_SEED } from '@tourlint/shared';
import { AccountRepository } from '../auth/account.repository';
import { SettingsTablesRepository } from './settings-tables.repository';

const URL = process.env.TEST_DATABASE_URL;

if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

describe.skipIf(URL === undefined)('SettingsTablesRepository — 실 DB', () => {
  let pool: Pool;
  let repo: SettingsTablesRepository;
  let a1: number;
  let a2: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL });
    repo = new SettingsTablesRepository(pool);
    const acc = new AccountRepository(pool);
    a1 = (await acc.create(`tab1-${Date.now()}@t.test`, 'hash')).id;
    a2 = (await acc.create(`tab2-${Date.now()}@t.test`, 'hash')).id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM account WHERE id = ANY($1)`, [[a1, a2]]);
    await pool.end();
  });

  it('시드 전체를 현재값·기본값과 함께 돌려준다', async () => {
    const dwell = await repo.dwell(a1);
    const io = await repo.indoorOutdoor(a1);
    expect(dwell).toHaveLength(Object.keys(DWELL_MINUTES_SEED).length);
    expect(io).toHaveLength(Object.keys(INDOOR_OUTDOOR_SEED).length);
    // 편집 전이면 현재값 = 기본값
    const ev01 = dwell.find((e) => e.lcls2 === 'EV01');
    expect(ev01?.minutes).toBe(ev01?.defaultMinutes);
  });

  it('저장하면 그 값을 읽고 기본값은 그대로다', async () => {
    await repo.saveDwell(a1, [{ lcls2: 'EV01', minutes: 150 }]);
    await repo.saveIndoorOutdoor(a1, [{ lcls2: 'AC01', spaceType: 'OUTDOOR' }]);
    const ev01 = (await repo.dwell(a1)).find((e) => e.lcls2 === 'EV01');
    const ac01 = (await repo.indoorOutdoor(a1)).find((e) => e.lcls2 === 'AC01');
    expect(ev01?.minutes).toBe(150);
    expect(ev01?.defaultMinutes).toBe(DWELL_MINUTES_SEED.EV01);
    expect(ac01?.spaceType).toBe('OUTDOOR');
    expect(ac01?.defaultSpaceType).toBe(INDOOR_OUTDOOR_SEED.AC01);
  });

  it('계정 기준표는 서로 격리된다 (PM-DA-005)', async () => {
    // a1 만 EV01·AC01 을 바꿨다. a2 는 기본값이어야 한다.
    const ev01 = (await repo.dwell(a2)).find((e) => e.lcls2 === 'EV01');
    const ac01 = (await repo.indoorOutdoor(a2)).find((e) => e.lcls2 === 'AC01');
    expect(ev01?.minutes).toBe(DWELL_MINUTES_SEED.EV01);
    expect(ac01?.spaceType).toBe(INDOOR_OUTDOOR_SEED.AC01);
  });

  it('R10 프로파일 전체 교체 — 보낸 집합만 남는다', async () => {
    await repo.saveProfiles(a1, [
      { targetKey: 'T1', conceptKey: 'C1', expectedLcls2: ['AC01', 'EV01'], expectsNight: true },
      { targetKey: 'T2', conceptKey: 'C2', expectedLcls2: ['AC02'], expectsNight: false },
    ]);
    expect(await repo.profiles(a1)).toHaveLength(2);
    // 다시 하나만 보내면 나머지는 사라진다 (upsert 가 아니라 교체)
    await repo.saveProfiles(a1, [
      { targetKey: 'T1', conceptKey: 'C1', expectedLcls2: ['AC01', 'EV01'], expectsNight: true },
    ]);
    const after = await repo.profiles(a1);
    expect(after).toHaveLength(1);
    expect(after[0]?.expectedLcls2).toEqual(['AC01', 'EV01']);
    expect(after[0]?.expectsNight).toBe(true);
  });

  it('R10 프로파일도 계정 격리 — a1 교체가 a2 를 안 건드린다', async () => {
    const a2p = await repo.profiles(a2);
    expect(a2p.some((p) => p.targetKey === 'T1')).toBe(false);
  });
});
