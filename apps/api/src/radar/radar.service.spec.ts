import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { SignalBatchJob } from '../batch/signal-batch.job';
import { SignalRunner } from '../batch/signal-runner';
import { nextBatchAt } from '../batch/sync-window';
import { InMemoryApiCallLogger } from '../external/api-call-log';
import { FixtureKtoTransport, KtoClient } from '../external/kto';
import { DomainException } from '../common/domain.exception';
import { BATCH_KEY, BatchStateRepository } from '../persistence/batch-state.repository';
import { DemandSignalRepository } from '../persistence/demand-signal.repository';
import { RadarRepository } from './radar.repository';
import { RadarService } from './radar.service';

/**
 * 레이더 관통 — **실 DB**. 공사 호출은 0건이다 (저장된 값만 읽는다).
 */

const URL = process.env.TEST_DATABASE_URL;
let counter = 0;
if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

describe.skipIf(URL === undefined)('RadarService — 관통', () => {
  let pool: Pool;
  let service: RadarService;
  let signals: DemandSignalRepository;
  let mine: number;
  let theirs: number;
  let productId: number;

  beforeAll(() => {
    pool = new Pool({ connectionString: URL, max: 4 });
    service = new RadarService(pool);
    signals = new DemandSignalRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    const accounts = await pool.query<{ id: string }>(
      `INSERT INTO account (email, password_hash) VALUES ($1,'x'), ($2,'x') RETURNING id`,
      [`radar-${String(process.pid)}-${String(counter++)}@example.com`,
       `radar-${String(process.pid)}-${String(counter++)}@example.com`],
    );
    mine = Number(accounts.rows[0]?.id);
    theirs = Number(accounts.rows[1]?.id);

    const prod = await pool.query<{ id: string }>(
      `INSERT INTO product (account_id, name, ldong_regn_cd, ldong_signgu_cd,
                            start_date, nights, transport)
       VALUES ($1,'강릉 1박 2일','51','150', DATE '2026-10-13', 1, 'CAR') RETURNING id`,
      [mine],
    );
    productId = Number(prod.rows[0]?.id);

    await pool.query(
      `INSERT INTO notification
         (product_id, kind, match_condition, kto_content_id, change_hash_from,
          change_hash_to, change_key, body)
       VALUES ($1,'RISK',1,'126508','aa','bb',$2,'{"condition":1,"hidden":false,
               "modifiedTime":"20260801120000"}'::jsonb)`,
      [productId, `k-${String(counter++)}`],
    );
  });

  afterEach(async () => {
    await pool.query('DELETE FROM demand_signal WHERE ldong_regn_cd = $1', ['51']);
    await pool.query('DELETE FROM account WHERE id = ANY($1::bigint[])', [[mine, theirs]]);
  });

  it('요약이 내 알림만 센다 (FR-MO-050 · PM-DA-002)', async () => {
    expect((await service.summary(mine)).risk).toBe(1);
    expect((await service.summary(theirs)).risk).toBe(0);
  });

  it('🔴 남의 변경 내역은 안 나온다 (PM-DA-002)', async () => {
    expect((await service.changes(mine, 0, 20)).totalElements).toBe(1);
    expect((await service.changes(theirs, 0, 20)).totalElements).toBe(0);
  });

  it('변경 내역에 지문 비교값이 실린다 (FR-MO-058)', async () => {
    const row = ((await service.changes(mine, 0, 20)).content as Record<string, unknown>[])[0];
    expect(row?.fingerprint).toEqual({ from: 'aa', to: 'bb' });
  });

  it('🔴 판독 결과 비교가 없으면 없다고 말한다 — 빈 배열을 「변화 없음」으로 읽으면 안 된다', () => {
    return service.changes(mine, 0, 20).then((res) => {
      const row = (res.content as Record<string, unknown>[])[0];
      expect(row?.hasReadableDiff).toBe(false);
      expect(row?.readableChanges).toEqual([]);
    });
  });

  it('🔴 남의 상품 신호는 볼 수 없다 — 404 (EX-SY-003)', async () => {
    await expect(service.signalsOf(theirs, productId)).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainException && e.getStatus() === 404,
    );
  });

  it('🔴 산출 전이면 신호가 null 이다 — 0 이 아니다', async () => {
    const res = await service.signalsOf(mine, productId);
    expect(res.t1).toBeNull();
    expect(res.t2).toBeNull();
  });

  it('배치가 산출해 두면 그 값을 읽는다 (FR-MO-056 조회 조건 포함)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    await signals.upsert('T1', {
      count: 4,
      byType: { '12': 3, '15': 1 },
      byKeyword: {},
      window: { ldongRegnCd: '51', ldongSignguCd: '150', from, to: today },
    }, new Date());

    const t1 = (await service.signalsOf(mine, productId)).t1 as Record<string, unknown>;
    expect(t1.count).toBe(4);
    expect(t1.byType).toEqual({ '12': 3, '15': 1 });
    expect((t1.window as Record<string, unknown>).from).toBe(from);
  });

  describe('관심 키워드 일치 (FR-RU-112 · DR-PR-009)', () => {
    const t1Of = async (accountId: number, id: number): Promise<Record<string, unknown>> =>
      (await service.signalsOf(accountId, id)).t1 as Record<string, unknown>;

    const saveT1 = async (byKeyword: Record<string, string[]>): Promise<void> => {
      const today = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
      await signals.upsert('T1', {
        count: 9, byType: { '12': 9 }, byKeyword,
        window: { ldongRegnCd: '51', ldongSignguCd: '150', from, to: today },
      }, new Date());
    };

    const keywordsOf = (accountId: number, keywords: string[]) =>
      pool.query(`INSERT INTO user_setting (account_id, watch_keywords) VALUES ($1, $2)`, [accountId, keywords]);

    it('🔴 계정마다 자기 키워드의 일치 곳만 본다 — 같은 지역 남의 키워드는 드러나지 않는다', async () => {
      const other = await pool.query<{ id: string }>(
        `INSERT INTO product (account_id, name, ldong_regn_cd, ldong_signgu_cd, start_date, nights, transport)
         VALUES ($1,'강릉 당일','51','150', DATE '2026-11-02', 0, 'CAR') RETURNING id`,
        [theirs],
      );
      await keywordsOf(mine, ['온천']);
      await keywordsOf(theirs, ['커피']);
      await saveT1({ '온천': ['123', '456'], '커피': ['789'] });

      const t1Mine = await t1Of(mine, productId);
      expect(t1Mine.keywordHits).toEqual([{ keyword: '온천', contentIds: ['123', '456'] }]);
      expect(JSON.stringify(t1Mine)).not.toContain('커피');

      const t1Theirs = await t1Of(theirs, Number(other.rows[0]?.id));
      expect(t1Theirs.keywordHits).toEqual([{ keyword: '커피', contentIds: ['789'] }]);
      // 건수는 거르지 않는다 — 키워드가 달라도 T1 은 같은 지역 전체다
      expect(t1Mine.count).toBe(9);
      expect(t1Theirs.count).toBe(9);
    });

    it('🔴 배치가 아직 안 본 키워드는 null 이다 — 빈 배열(세어 보니 없음)과 가른다', async () => {
      await keywordsOf(mine, ['온천', '바다']);
      await saveT1({ '온천': [] });
      expect((await t1Of(mine, productId)).keywordHits).toEqual([
        { keyword: '온천', contentIds: [] },
        { keyword: '바다', contentIds: null },
      ]);
    });

    it('관심 키워드가 없는 계정은 빈 목록이다', async () => {
      await saveT1({ '온천': ['123'] });
      expect((await t1Of(mine, productId)).keywordHits).toEqual([]);
    });

    it('🔴 저장된 일치에는 contentid 만 있다 — 제목이 없다', async () => {
      await keywordsOf(mine, ['온천']);
      await saveT1({ '온천': ['123'] });
      const { rows } = await pool.query<{ by_keyword: unknown }>(
        `SELECT by_keyword FROM demand_signal WHERE ldong_regn_cd = '51' AND signal_type = 'T1'`,
      );
      expect(rows.map((r) => r.by_keyword)).toEqual([{ '온천': ['123'] }]);
    });
  });

  it('🔴 신호 배치 대상 상품에 그 계정의 관심 키워드가 실린다 — 설정 행이 없으면 빈 목록 (FR-RU-112)', async () => {
    const other = await pool.query<{ id: string }>(
      `INSERT INTO product (account_id, name, ldong_regn_cd, ldong_signgu_cd, start_date, nights, transport)
       VALUES ($1,'강릉 당일','51','150', DATE '2026-11-02', 0, 'CAR') RETURNING id`,
      [theirs],
    );
    await pool.query(`INSERT INTO user_setting (account_id, watch_keywords) VALUES ($1, $2)`, [mine, ['온천', '야행']]);

    const watched = await new RadarRepository(pool).watchedRegions('2026-09-01');
    const byId = new Map(watched.map((w) => [w.productId, w.keywords]));
    expect(byId.get(productId)).toEqual(['온천', '야행']);
    expect(byId.get(Number(other.rows[0]?.id))).toEqual([]);
  });

  it('요약에 마지막 · 다음 배치 시각이 실린다 (API 4-8)', async () => {
    const now = new Date('2026-09-15T04:10:00+09:00');
    const setting = await new BatchStateRepository(pool).setting();
    const summary = await service.summary(mine, now);
    expect(summary.nextBatchAt).toBe(nextBatchAt(now, setting.batchTime, setting.batchEnabled));
    expect(summary).toHaveProperty('lastBatchAt');
  });

  describe('관심 지역 새 소식 (FR-MO-059 · 060 · API 4-8)', () => {
    const NOW = new Date('2026-09-15T12:00:00+09:00');
    const GANGNEUNG = { ldongRegnCd: '51', ldongSignguCd: '150' };
    const watchOf = (accountId: number, regions: unknown[], keywords: string[] = []) =>
      pool.query(
        `INSERT INTO user_setting (account_id, watch_regions, watch_keywords) VALUES ($1, $2::jsonb, $3)`,
        [accountId, JSON.stringify(regions), keywords],
      );

    it('🔴 관심 지역마다 t1 · t2 · t3 를 싣고, 산출 전 · 지난해 코드와 안 이어지는 지역은 null 이다', async () => {
      await watchOf(mine, [
        { regnCd: '51', signguCd: '150', month: '2026-10' },
        { regnCd: '12', signguCd: '110', month: '2026-10' },
      ], ['커피']);
      await signals.upsert('T1', { count: 5, byType: { '12': 5 }, byKeyword: { '커피': ['9'] },
        window: { ...GANGNEUNG, from: '2026-08-16', to: '2026-09-14' } }, NOW);
      await signals.upsert('T2', { count: 3, byType: { '15': 3 }, byKeyword: { '커피': ['101'] },
        window: { ...GANGNEUNG, from: '2026-10-01', to: '2026-10-31' } }, NOW);
      await signals.upsert('T3', { count: 1_120_000, byType: {}, byKeyword: {},
        window: { ...GANGNEUNG, from: '2025-10-01', to: '2025-10-31' } }, NOW);

      const res = await service.regionSignals(mine, NOW);
      expect(res).toHaveLength(2);
      expect(res[0]).toMatchObject({
        region: { regnCd: '51', signguCd: '150' },
        month: '2026-10',
        // T1 은 가장 최근 창(어제 센 값)이다
        t1: { count: 5, window: { to: '2026-09-14' }, keywordHits: [{ keyword: '커피', contentIds: ['9'] }] },
        t2: { count: 3, window: { from: '2026-10-01', to: '2026-10-31' }, keywordHits: [{ keyword: '커피', contentIds: ['101'] }] },
        t3: { count: 1_120_000, basisMonth: '2025-10', source: '빅데이터 지역별 방문자수' },
      });
      expect(res[1]).toMatchObject({ region: { regnCd: '12', signguCd: '110' }, t1: null, t2: null, t3: null });
    });

    it('🔴 남의 관심 지역은 안 나온다 (PM-DA-002)', async () => {
      await watchOf(mine, [{ regnCd: '51', signguCd: '150', month: '2026-10' }]);
      expect(await service.regionSignals(theirs, NOW)).toEqual([]);
    });

    it('🔴 T3 에 인기 · 예측 필드가 없다 — 관측된 수 · 기준 기간 · 출처뿐이다 (FR-MO-060)', async () => {
      await watchOf(mine, [{ regnCd: '51', signguCd: '150', month: '2026-10' }]);
      await signals.upsert('T3', { count: 10, byType: {}, byKeyword: {},
        window: { ...GANGNEUNG, from: '2025-10-01', to: '2025-10-31' } }, NOW);
      const t3 = (await service.regionSignals(mine, NOW))[0]?.t3 as Record<string, unknown>;
      expect(Object.keys(t3).sort()).toEqual(['basisMonth', 'computedAt', 'count', 'source']);
    });

    it('모양이 틀린 관심 지역 칸은 뺀다 — 엉뚱한 지역을 세지 않는다', async () => {
      await watchOf(mine, [
        { regnCd: '51', signguCd: '150', month: '2026-10' },
        { regnCd: '51', signguCd: '15', month: '2026-10' },
        { regnCd: '51', signguCd: '150', month: '2026-13' },
        { regnCd: '36110', signguCd: null, month: '2026-11' },
        'x',
      ]);
      const regions = await new RadarRepository(pool).watchRegions(mine);
      expect(regions.map((w) => `${w.ldongRegnCd}:${w.ldongSignguCd}:${w.month}`)).toEqual(['51:150:2026-10', '36110:null:2026-11']);
    });

    describe('지금 산출 (region-signals/refresh)', () => {
      const setGlobal = async (patch: { batchEnabled?: boolean; dailyQuota?: number }): Promise<() => Promise<void>> => {
        const before = await new BatchStateRepository(pool).setting();
        await pool.query(
          `UPDATE system_setting SET batch_enabled = COALESCE($1, batch_enabled), daily_quota = COALESCE($2, daily_quota) WHERE key = 'global'`,
          [patch.batchEnabled ?? null, patch.dailyQuota ?? null],
        );
        return async () => {
          await pool.query(
            `UPDATE system_setting SET batch_enabled = $1, daily_quota = $2 WHERE key = 'global'`,
            [before.batchEnabled, before.dailyQuota],
          );
        };
      };

      const fixtureJob = (transport: FixtureKtoTransport): SignalBatchJob => new SignalBatchJob({
        runner: new SignalRunner({ kto: () => new KtoClient({ transport, logger: new InMemoryApiCallLogger() }) }),
        signals,
        radar: new RadarRepository(pool),
        hasBudget: async () => true,
      });

      it('🔴 배치가 켜져 있으면 403 이다 — 평일 아침마다 배치가 센다', async () => {
        const restore = await setGlobal({ batchEnabled: true });
        try {
          const transport = new FixtureKtoTransport(join(__dirname, '../../../../fixtures/kto'));
          await watchOf(mine, [{ regnCd: '51', signguCd: '150', month: '2026-10' }]);
          await expect(new RadarService(pool, fixtureJob(transport)).refreshRegionSignals(mine)).rejects.toSatisfy(
            (e: unknown) => e instanceof DomainException && e.getStatus() === 403 && e.reasonCode === 'FORBIDDEN_ACTION',
          );
          expect([...transport.replayCounts.values()].reduce((a, b) => a + b, 0)).toBe(0);
        } finally {
          await restore();
        }
      });

      it('🔴 꺼진 기간에는 산출해 돌려주고, 오늘 이미 센 T1 · T2 는 다시 부르지 않는다', async () => {
        const restore = await setGlobal({ batchEnabled: false });
        try {
          const transport = new FixtureKtoTransport(join(__dirname, '../../../../fixtures/kto'));
          const refreshing = new RadarService(pool, fixtureJob(transport));
          await watchOf(mine, [{ regnCd: '51', signguCd: '150', month: '2026-10' }]);

          const first = await refreshing.refreshRegionSignals(mine);
          expect(first[0]?.t1).not.toBeNull();
          expect(first[0]?.t2).not.toBeNull();
          // 픽스처에 2025년 10월 방문자수가 없어 T3 는 세지 못한다 — 0 이 아니라 null 이다
          expect(first[0]?.t3).toBeNull();

          const counts = (): Record<string, number> => Object.fromEntries(transport.replayCounts);
          const afterFirst = counts();
          await refreshing.refreshRegionSignals(mine);
          expect(counts().areaBasedList2).toBe(afterFirst.areaBasedList2);
          expect(counts().searchFestival2).toBe(afterFirst.searchFestival2);
        } finally {
          await restore();
        }
      });

      it('🔴 국문 관광정보 예산이 다 찼으면 부르기 전에 429 BUDGET_EXHAUSTED 다 (PLAN 100%)', async () => {
        const restore = await setGlobal({ batchEnabled: false, dailyQuota: 1 });
        const marker = `zz-radar-refresh-${String(process.pid)}`;
        try {
          // 다른 스펙의 호출 로그 정리(called_at 기준)에 쓸리지 않게 호출 시각은 어제로 두고 날짜만 오늘로 센다
          await pool.query(
            `INSERT INTO api_call_log (provider, operation, called_at, quota_date, status, latency_ms)
             VALUES ('KTO', $1, now() - interval '1 day', (now() AT TIME ZONE 'Asia/Seoul')::date, 'OK', 1)`,
            [marker],
          );
          const transport = new FixtureKtoTransport(join(__dirname, '../../../../fixtures/kto'));
          await watchOf(mine, [{ regnCd: '51', signguCd: '150', month: '2026-10' }]);
          await expect(new RadarService(pool, fixtureJob(transport)).refreshRegionSignals(mine)).rejects.toSatisfy(
            (e: unknown) => e instanceof DomainException && e.getStatus() === 429 && e.reasonCode === 'BUDGET_EXHAUSTED',
          );
          expect(transport.replayCounts.size).toBe(0);
        } finally {
          await pool.query(`DELETE FROM api_call_log WHERE operation = $1`, [marker]);
          await restore();
        }
      });
    });
  });

  describe('T1 은 한국 날짜 기준 가장 최근 창이다', () => {
    const saveT1 = (to: string, from: string, count: number) => signals.upsert('T1', {
      count, byType: { '12': count }, byKeyword: {}, window: { ldongRegnCd: '51', ldongSignguCd: '150', from, to },
    }, new Date());

    it('🔴 한국 시간으로 오늘 창을 읽는다 — UTC 날짜로 찾으면 오전 9시 전까지 어제 값이 나온다', async () => {
      await saveT1('2026-09-14', '2026-08-16', 1);
      await saveT1('2026-09-15', '2026-08-17', 2);
      // 2026-09-15 06:00 KST(배치 뒤) = 2026-09-14 21:00 UTC
      const t1 = (await service.signalsOf(mine, productId, new Date('2026-09-14T21:00:00Z'))).t1 as Record<string, unknown>;
      expect(t1.count).toBe(2);
    });

    it('🔴 오늘 창이 없으면 가장 최근 창을 읽는다 — 배치가 오늘 안 돌았다고 「아직 안 셌다」가 되지 않는다', async () => {
      await saveT1('2026-09-14', '2026-08-16', 1);
      // 2026-09-15 09:30 KST. 오늘 창이 없다
      const t1 = (await service.signalsOf(mine, productId, new Date('2026-09-15T00:30:00Z'))).t1 as Record<string, unknown>;
      expect(t1.count).toBe(1);
      expect((t1.window as Record<string, unknown>).to).toBe('2026-09-14');
    });
  });

  it('🔴 응답에 강도 점수가 없다 (FR-RU-121)', async () => {
    const res = await service.signalsOf(mine, productId);
    expect(JSON.stringify(res)).not.toMatch(/"(score|strength|intensity|강도)"/);
  });

  it('🔴 요약에 마지막 배치 상태가 실린다 (NF-OB-004)', async () => {
    /*
     * `toHaveProperty` 만 보던 검사는 `lastBatch: null` 도 통과시켰다. 실제로 키를
     * `'sync'` 로 지어내 두는 바람에 운영에서 영영 null 이 나갔다 — 배치가 도는데도
     * 「배치 기록 없음」으로 보인다. 배치가 쓰는 키로 실제 행을 읽는지 본다.
     */
    await pool.query(
      `INSERT INTO batch_state (key, last_covered, last_run_at, last_status, last_item_count)
       VALUES ($1, DATE '2026-08-29', now(), 'OK', 7)
       ON CONFLICT (key) DO UPDATE
         SET last_covered = EXCLUDED.last_covered, last_run_at = EXCLUDED.last_run_at,
             last_status = EXCLUDED.last_status, last_item_count = EXCLUDED.last_item_count`,
      [BATCH_KEY],
    );
    const batch = (await service.summary(mine)).lastBatch as Record<string, unknown> | null;
    expect(batch).not.toBeNull();
    expect(batch?.status).toBe('OK');
    expect(batch?.covered).toBe('2026-08-29');
    expect(batch?.itemCount).toBe(7);
  });
});
