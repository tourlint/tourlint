import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DomainException } from '../common/domain.exception';
import { DemandSignalRepository } from '../persistence/demand-signal.repository';
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
      window: { ldongRegnCd: '51', ldongSignguCd: '150', from, to: today },
    }, new Date());

    const t1 = (await service.signalsOf(mine, productId)).t1 as Record<string, unknown>;
    expect(t1.count).toBe(4);
    expect(t1.byType).toEqual({ '12': 3, '15': 1 });
    expect((t1.window as Record<string, unknown>).from).toBe(from);
  });

  it('🔴 응답에 강도 점수가 없다 (FR-RU-121)', async () => {
    const res = await service.signalsOf(mine, productId);
    expect(JSON.stringify(res)).not.toMatch(/"(score|strength|intensity|강도)"/);
  });

  it('요약에 마지막 배치 상태가 실린다 (NF-OB-004)', async () => {
    const res = await service.summary(mine);
    expect(res).toHaveProperty('lastBatch');
  });
});
