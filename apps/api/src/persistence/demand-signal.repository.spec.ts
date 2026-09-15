import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignalRunner } from '../batch/signal-runner';
import { InMemoryApiCallLogger } from '../external/api-call-log';
import { FixtureKtoTransport, KtoClient } from '../external/kto';
import { DemandSignalRepository } from './demand-signal.repository';

const FIXTURES = join(__dirname, '../../../../fixtures/kto');
const URL = process.env.TEST_DATABASE_URL;

if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

describe.skipIf(URL === undefined)('DemandSignalRepository — 실 DB', () => {
  let pool: Pool;
  let repo: DemandSignalRepository;
  // 레이더 스펙이 지역 51 행을 지운다. 이 스펙은 다른 지역 코드로 저장해 서로 지우지 않는다
  const STORED = { ldongRegnCd: '98', ldongSignguCd: '980' };

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL });
    repo = new DemandSignalRepository(pool);
    await pool.query(`DELETE FROM demand_signal WHERE ldong_regn_cd = $1`, [STORED.ldongRegnCd]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM demand_signal WHERE ldong_regn_cd = $1`, [STORED.ldongRegnCd]);
    await pool.end();
  });

  it('🔴 실호출 목록으로 산출한 T1 을 저장해도 행 어디에도 제목이 없다 — 키워드 일치는 contentid 뿐이다 (DR-PR-009)', async () => {
    const runner = new SignalRunner({
      kto: () => new KtoClient({ transport: new FixtureKtoTransport(FIXTURES), logger: new InMemoryApiCallLogger() }),
    });
    // 05_areaBasedList2 픽스처(강릉) 가운데 2025년 9월에 등록된 곳이 창 안에 든다
    const window = { ldongRegnCd: '51', ldongSignguCd: '150', from: '2025-09-01', to: '2025-09-30' };
    const signal = await runner.t1(window, ['감천', '없는말']);
    if (signal === null) throw new Error('픽스처로 T1 을 산출하지 못했다');
    expect(signal.byKeyword).toEqual({ '감천': ['3536478'], '없는말': [] });

    await repo.upsert('T1', { ...signal, window: { ...window, ...STORED } }, new Date());
    const { rows } = await pool.query<{ row: string }>(
      `SELECT row_to_json(d)::text AS row FROM demand_signal d WHERE region_key = '98:980' AND signal_type = 'T1'`,
    );
    expect(rows).toHaveLength(1);
    const stored = rows[0]?.row ?? '';

    const raw = JSON.parse(readFileSync(join(FIXTURES, '05_areaBasedList2.json'), 'utf8')) as {
      response: { body: { items: { item: { title: string; addr1: string }[] } } };
    };
    for (const text of raw.response.body.items.item.flatMap((i) => [i.title, i.addr1])) {
      if (text !== '') expect(stored, text).not.toContain(text);
    }
    expect((JSON.parse(stored) as { by_keyword: unknown }).by_keyword).toEqual({ '감천': ['3536478'], '없는말': [] });
  });

  it('저장한 키워드 일치를 읽어 돌려주고, 산출하지 않은 창은 null 이다', async () => {
    const window = { ...STORED, from: '2025-10-01', to: '2025-10-30' };
    await repo.upsert('T1', { count: 2, byType: { '12': 2 }, byKeyword: { '온천': ['1', '2'] }, window }, new Date());

    expect((await repo.find('T1', window))?.byKeyword).toEqual({ '온천': ['1', '2'] });
    expect(await repo.find('T1', { ...window, from: '2025-10-02' })).toBeNull();
  });

  it('다시 산출하면 키워드 일치도 덮어쓴다 — 나중 배치 값이 맞다', async () => {
    const window = { ...STORED, from: '2025-11-01', to: '2025-11-30' };
    await repo.upsert('T1', { count: 1, byType: {}, byKeyword: { '온천': ['1'] }, window }, new Date());
    await repo.upsert('T1', { count: 1, byType: {}, byKeyword: { '온천': [], '바다': ['7'] }, window }, new Date());
    expect((await repo.find('T1', window))?.byKeyword).toEqual({ '온천': [], '바다': ['7'] });
  });
});
