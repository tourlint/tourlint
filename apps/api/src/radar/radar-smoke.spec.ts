import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DemandSignalRepository } from '../persistence/demand-signal.repository';
import { t2Window } from '../engine/signals';
import { RadarService } from './radar.service';

/**
 * 레이더 스모크 — 대표 시나리오 하나를 더미데이터로 깔고, 요약 · 변경 내역 · 수요 신호 ·
 * 관심 지역 새 소식이 **한 계정 범위**로 맞물려 나오는지 관통한다.
 *
 * 실 DB 다. 읽기 경로는 공사 호출 0건이다(배치가 저장해 둔 값만 읽는다). `TEST_DATABASE_URL`
 * 이 없으면 조용히 건너뛴다 — 값을 넣어 돌리면 DB 연동을 실제로 검증한다.
 */

const URL = process.env.TEST_DATABASE_URL;
const GN = { ldongRegnCd: '88', ldongSignguCd: '880' }; // 테스트 전용 가짜 지역 코드. 다른 스펙과 겹치지 않아 병렬 실행에도 안 부딪힌다
let seq = 0;

describe.skipIf(URL === undefined)('레이더 스모크 — 대표 시나리오 관통', () => {
  // 배치가 한국 날짜로 창을 만든다. 시각을 고정해 「오늘」을 결정론으로 둔다(NF-MT-001).
  const NOW = new Date('2026-09-20T12:00:00+09:00');
  let pool: Pool;
  let service: RadarService;
  let signals: DemandSignalRepository;
  let mine = 0;
  let theirs = 0;
  let productId = 0;

  beforeAll(() => {
    pool = new Pool({ connectionString: URL, max: 4 });
    service = new RadarService(pool);
    signals = new DemandSignalRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    const acc = await pool.query<{ id: string }>(
      `INSERT INTO account (email, password_hash) VALUES ($1,'x'), ($2,'x') RETURNING id`,
      [`radar-smoke-${String(process.pid)}-${String(seq++)}@example.com`,
       `radar-smoke-${String(process.pid)}-${String(seq++)}@example.com`],
    );
    mine = Number(acc.rows[0]?.id);
    theirs = Number(acc.rows[1]?.id);

    // 출발이 아직 안 지난 상품이라야 레이더가 센다 (start_date + nights >= 오늘).
    const prod = await pool.query<{ id: string }>(
      `INSERT INTO product (account_id, name, ldong_regn_cd, ldong_signgu_cd, start_date, nights, transport)
       VALUES ($1,'테스트시 1박 2일','88','880', DATE '2026-10-13', 1, 'CAR') RETURNING id`,
      [mine],
    );
    productId = Number(prod.rows[0]?.id);

    // 변경 알림 둘 — 위험 하나 · 기회 하나, 서로 다른 콘텐츠. read_at 이 비어 있어 미확인이다.
    for (const [kind, cond, content] of [['RISK', 1, '126508'], ['OPPORTUNITY', 5, '338921']] as const) {
      await pool.query(
        `INSERT INTO notification
           (product_id, kind, match_condition, kto_content_id,
            change_hash_from, change_hash_to, change_key, body)
         VALUES ($1,$2,$3,$4,'aa','bb',$5,'{"condition":1,"hidden":false,
                 "modifiedTime":"20260801120000"}'::jsonb)`,
        [productId, kind, cond, content, `k-${String(process.pid)}-${String(seq++)}`],
      );
    }

    // 관심 지역(테스트시 · 2026-10) + 관심 키워드(커피)
    await pool.query(
      `INSERT INTO user_setting (account_id, watch_regions, watch_keywords) VALUES ($1, $2::jsonb, $3)`,
      [mine, JSON.stringify([{ regnCd: '88', signguCd: '880', month: '2026-10' }]), ['커피']],
    );

    // 배치가 산출해 둔 신호.
    // T1 — 가장 최근 창(window_to <= 오늘). findLatestT1 은 정확 일치가 아니라 최신을 읽는다.
    await signals.upsert('T1', { count: 5, byType: { '12': 5 }, byKeyword: { '커피': ['9'] },
      window: { ...GN, from: '2026-08-21', to: '2026-09-19' } }, NOW);
    // T2(상품) — signalsOf 는 여행 기간 창(t2Window, 앞뒤 여유)으로 정확 일치를 찾는다.
    const tripWindow = t2Window('2026-10-13', 1, GN);
    if (tripWindow === null) throw new Error('t2Window 가 null 이면 안 된다');
    await signals.upsert('T2', { count: 7, byType: { '15': 7 }, byKeyword: {}, window: tripWindow }, NOW);
    // T2(관심 지역) — regionSignals 는 그 달(monthWindow)로 찾는다. 상품 창과 달라 별도 행이다.
    await signals.upsert('T2', { count: 3, byType: { '15': 3 }, byKeyword: { '커피': ['101'] },
      window: { ...GN, from: '2026-10-01', to: '2026-10-31' } }, NOW);
    // T3(관심 지역) — 지난해 같은 달(lastYearMonthWindow).
    await signals.upsert('T3', { count: 1_120_000, byType: {}, byKeyword: {},
      window: { ...GN, from: '2025-10-01', to: '2025-10-31' } }, NOW);
  });

  afterEach(async () => {
    await pool.query('DELETE FROM demand_signal WHERE ldong_regn_cd = $1', ['88']);
    await pool.query('DELETE FROM account WHERE id = ANY($1::bigint[])', [[mine, theirs]]);
  });

  it('요약 · 변경 · 수요 신호 · 관심 지역이 한 계정으로 맞물려 나온다', async () => {
    const summary = await service.summary(mine, NOW);
    expect(summary).toMatchObject({
      risk: 1, opportunity: 1, unread: 2, affectedProducts: 1, changedContents: 2,
    });

    const changes = await service.changes(mine, 0, 20);
    expect(changes.totalElements).toBe(2);

    const sig = await service.signalsOf(mine, productId, NOW);
    const t1 = sig.t1 as Record<string, unknown>;
    expect(t1.count).toBe(5);
    expect(t1.keywordHits).toEqual([{ keyword: '커피', contentIds: ['9'] }]);
    expect((sig.t2 as Record<string, unknown>).count).toBe(7);

    const regions = await service.regionSignals(mine, NOW);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({
      region: { regnCd: '88', signguCd: '880' },
      month: '2026-10',
      t1: { count: 5 },
      t2: { count: 3 },
      t3: { count: 1_120_000, basisMonth: '2025-10' },
    });
  });

  it('🔴 남의 계정에는 아무것도 새지 않는다 (PM-DA-002)', async () => {
    const summary = await service.summary(theirs, NOW);
    expect(summary).toMatchObject({
      risk: 0, opportunity: 0, unread: 0, affectedProducts: 0, changedContents: 0,
    });
    expect((await service.changes(theirs, 0, 20)).totalElements).toBe(0);
    expect(await service.regionSignals(theirs, NOW)).toEqual([]);
  });
});
