import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLIMATE_NORMAL_PERIOD, CLIMATE_SOURCE_NOTE, CLIMATE_STATION, climateStationOf } from '@tourlint/shared';
import { ClimateNormalRepository } from './climate-normal.repository';

const URL = process.env.TEST_DATABASE_URL;

if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

describe('시도 대표 지점 (EI-WX-004)', () => {
  it('중기 예보구역이 있는 시도는 평년 지점도 있다', () => {
    // 한쪽만 있으면 그 시도는 D+10 까지만 판정되고 그 뒤가 비어 버린다
    for (const sido of ['11', '26', '27', '28', '29', '30', '31', '36', '41', '42', '51', '43', '44', '45', '52', '46', '12', '47', '48', '50']) {
      expect(climateStationOf(sido), `시도 ${sido}`).not.toBeNull();
    }
  });

  it('모르는 시도는 지점을 지어내지 않는다', () => {
    expect(climateStationOf('99')).toBeNull();
    expect(climateStationOf(null)).toBeNull();
  });

  it('강원 두 코드가 같은 지점을 본다', () => {
    expect(CLIMATE_STATION['42']).toEqual(CLIMATE_STATION['51']);
    expect(CLIMATE_STATION['51']?.name).toBe('강릉');
  });
});

describe.skipIf(URL === undefined)('ClimateNormalRepository — 실 DB', () => {
  let pool: Pool;
  let repo: ClimateNormalRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL });
    await pool.query(`DELETE FROM climate_normal WHERE ldong_regn_cd IN ('51', '11')`);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM climate_normal WHERE ldong_regn_cd IN ('51', '11')`);
    await pool.end();
  });

  beforeEach(() => {
    repo = new ClimateNormalRepository(pool);
  });

  async function seed(sido: string, month: number, rainDays: number, ratio: number): Promise<void> {
    await pool.query(
      `INSERT INTO climate_normal (ldong_regn_cd, month, rain_days, rain_ratio, normal_period, source_note)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (ldong_regn_cd, month) DO UPDATE SET rain_days = EXCLUDED.rain_days, rain_ratio = EXCLUDED.rain_ratio`,
      [sido, month, rainDays, ratio, CLIMATE_NORMAL_PERIOD, CLIMATE_SOURCE_NOTE],
    );
  }

  it('시도 · 월로 찾고 지점명을 붙여 준다 (FR-RU-092)', async () => {
    await seed('51', 9, 9.2, 0.307);
    expect(await repo.find('51', 9)).toEqual({ rainDays: 9.2, rainRatio: 0.307, regionName: '강릉' });
  });

  it('🔴 그 시도 · 월이 없으면 null 이다 — 다른 달로 대신 채우지 않는다', async () => {
    await seed('51', 9, 9.2, 0.307);
    expect(await repo.find('51', 10)).toBeNull();
    expect(await repo.find('11', 9)).toBeNull();
  });

  it('대표 지점이 없는 시도는 표에 값이 있어도 쓰지 않는다', async () => {
    // 지점명을 못 붙이면 판정 문장을 만들 수 없다
    await pool.query(
      `INSERT INTO climate_normal (ldong_regn_cd, month, rain_days, rain_ratio, normal_period, source_note)
       VALUES ('99', 9, 9.2, 0.307, $1, $2) ON CONFLICT DO NOTHING`,
      [CLIMATE_NORMAL_PERIOD, CLIMATE_SOURCE_NOTE],
    );
    try {
      expect(await repo.find('99', 9)).toBeNull();
    } finally {
      await pool.query(`DELETE FROM climate_normal WHERE ldong_regn_cd = '99'`);
    }
  });

  it('같은 시도 · 달을 여러 번 물어도 한 번만 조회한다', async () => {
    await seed('51', 9, 9.2, 0.307);
    let calls = 0;
    const counting = new ClimateNormalRepository({
      query: (...args: unknown[]) => { calls++; return pool.query(...(args as Parameters<Pool['query']>)); },
    } as unknown as Pool);

    // 2박 3일이면 같은 시도·달을 세 번 묻는다
    await counting.find('51', 9);
    await counting.find('51', 9);
    await counting.find('51', 9);
    expect(calls).toBe(1);
  });

  it('없다는 결과도 캐시한다 — 빈 표에 3회 조회가 3콜이 되지 않는다', async () => {
    let calls = 0;
    const counting = new ClimateNormalRepository({
      query: (...args: unknown[]) => { calls++; return pool.query(...(args as Parameters<Pool['query']>)); },
    } as unknown as Pool);

    await counting.find('11', 3);
    await counting.find('11', 3);
    expect(calls).toBe(1);
  });
});
