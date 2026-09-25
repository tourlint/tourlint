import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALL_PROVIDER as SHARED_CALL_PROVIDER } from '@tourlint/shared';
import { CALL_PROVIDER, type ApiCallLogEntry, type ApiCallLogger } from '../external/api-call-log';
import { KtoClient } from '../external/kto/kto.client';
import type { KtoParams, KtoTransport, KtoTransportResult } from '../external/kto/transport';
import { PgApiCallLogger, RunScopedCallLogger } from './api-call-log.repository';

describe('호출 로그 제공자 목록', () => {
  it('🔴 usage/calls 가 받는 제공자가 DB CHECK 와 같은 공용 9값이다 — 새 서비스로 거를 수 있다', () => {
    expect([...CALL_PROVIDER]).toEqual([...SHARED_CALL_PROVIDER]);
  });
});

const URL = process.env.TEST_DATABASE_URL;

if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

/** 실호출처럼 로그를 남기는(`http`) 트랜스포트. 본문은 빈 목록이다 */
class OkTransport implements KtoTransport {
  readonly kind = 'http' as const;
  async request(_operation: string, _params: KtoParams): Promise<KtoTransportResult> {
    return {
      body: JSON.stringify({ response: { header: { resultCode: '0000', resultMsg: 'OK' }, body: { items: '', totalCount: 0 } } }),
      httpStatus: 200,
    };
  }
}

describe.skipIf(URL === undefined)('PgApiCallLogger — 서비스별 제공자 (실 DB)', () => {
  let pool: Pool;
  let logs: PgApiCallLogger;
  // 과거 고정일 — 다른 스펙이 쓰지 않는 날이라 이 날의 행만 지운다
  const DAY = '2026-01-07';
  const NOW = new Date('2026-01-07T03:00:00Z'); // KST 12:00

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL });
    logs = new PgApiCallLogger(pool);
    await pool.query(`DELETE FROM api_call_log WHERE quota_date = $1`, [DAY]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM api_call_log WHERE quota_date = $1`, [DAY]);
    await pool.end();
  });

  it('🔴 새 서비스 호출이 서비스별 제공자로 남고, 일자 · 제공자 · 오퍼레이션별로 집계된다 (FR-OP-007)', async () => {
    // 클라이언트는 로그 쓰기를 기다리지 않는다. 집계 전에 쓰기가 끝나야 한다
    const writes: Promise<void>[] = [];
    const logger: ApiCallLogger = {
      record: (entry: ApiCallLogEntry) => {
        const write = logs.record(entry);
        writes.push(write);
        return write;
      },
    };
    const client = new KtoClient({ transport: new OkTransport(), logger, clock: () => NOW });
    const region = { lDongRegnCd: '51', lDongSignguCd: '150' };

    await client.searchKeyword({ keyword: '강릉' });
    await client.withAreaBasedList(region);
    await client.withAreaBasedList(region);
    await client.courseList();
    await Promise.all(writes);

    const rows = await logs.dailyBreakdown({ from: DAY, to: DAY });
    expect(rows.map((r) => [r.provider, r.operation, r.count]).sort()).toEqual([
      ['KTO', 'searchKeyword2', 1],
      ['KTO_DURUNUBI', 'courseList', 1],
      ['KTO_WITH', 'withAreaBasedList2', 2],
    ]);

    const onlyWith = await logs.dailyBreakdown({ from: DAY, to: DAY, provider: 'KTO_WITH' });
    expect(onlyWith.map((r) => r.provider)).toEqual(['KTO_WITH']);

    // 국문 예산의 분자는 국문 호출만이다
    expect(await logs.countToday('KTO', NOW)).toBe(1);
    expect(await logs.countToday('KTO_WITH', NOW)).toBe(2);
  });
});


describe.skipIf(URL === undefined)('PgApiCallLogger — 오늘 한도 초과를 답했는가 (EX-QT-005 · #793 · 실 DB)', () => {
  let pool: Pool;
  beforeAll(() => { pool = new Pool({ connectionString: URL }); });
  afterAll(async () => { await pool.end(); });

  it('🔴 오늘(KST) 22 로 실패한 호출이 있을 때만 참이다 — 다른 날 · 다른 서비스 · 다른 코드는 거짓', async () => {
    /*
     * 한 연결의 트랜잭션 안에서 쓰고 되돌린다. 커밋하면 병렬로 도는 다른 스펙의 예산 문이
     * 「오늘 한도 초과」 를 읽고 막힌다(#790 의 레이더 스펙과 같은 함정). 날짜도 과거 고정일이다.
     */
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const logs = new PgApiCallLogger(client as unknown as Pool);
      const NOW = new Date('2026-01-08T03:00:00Z'); // KST 12:00
      const entry = (provider: 'KTO' | 'KTO_PET', iso: string, status: 'OK' | 'FAIL', resultCode: string | null) => ({
        provider, operation: 'zz-quota-spec', calledAt: new Date(iso), status, httpStatus: 200, resultCode, latencyMs: 1, auditRunId: null,
      });
      await logs.record(entry('KTO', '2026-01-08T01:00:00Z', 'FAIL', '30'));
      await logs.record(entry('KTO', '2026-01-08T01:01:00Z', 'OK', '0000'));
      await logs.record(entry('KTO', '2026-01-07T14:00:00Z', 'FAIL', '22')); // 전날 23:00 KST
      await logs.record(entry('KTO_PET', '2026-01-08T01:02:00Z', 'FAIL', '22'));
      expect(await logs.quotaRejectedToday('KTO', NOW)).toBe(false);
      expect(await logs.quotaRejectedToday('KTO_PET', NOW)).toBe(true);

      await logs.record(entry('KTO', '2026-01-08T01:03:00Z', 'FAIL', '22'));
      expect(await logs.quotaRejectedToday('KTO', NOW)).toBe(true);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe.skipIf(URL === undefined)('RunScopedCallLogger — 검수 하나가 낸 호출 잇기 (#466 · 실 DB)', () => {
  let pool: Pool;
  let logs: PgApiCallLogger;
  let accountId: number;
  let runId: number;
  // 다른 스펙이 쓰지 않는 날. 이 날의 행만 지운다
  const DAY = '2026-01-08';
  const AT = new Date('2026-01-08T03:00:00Z'); // KST 12:00

  const entry = (operation: string): ApiCallLogEntry => ({
    provider: 'KTO', operation, calledAt: AT, status: 'OK',
    httpStatus: 200, resultCode: '0000', latencyMs: 10, auditRunId: null,
  });

  const rowsOfDay = async (): Promise<[string, number | null][]> => {
    const { rows } = await pool.query<{ operation: string; audit_run_id: string | null }>(
      `SELECT operation, audit_run_id FROM api_call_log WHERE quota_date = $1 ORDER BY operation`,
      [DAY],
    );
    return rows.map((r) => [r.operation, r.audit_run_id === null ? null : Number(r.audit_run_id)]);
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL });
    logs = new PgApiCallLogger(pool);
    await pool.query(`DELETE FROM api_call_log WHERE quota_date = $1`, [DAY]);

    const acc = await pool.query<{ id: string }>(
      `INSERT INTO account (email, password_hash) VALUES ($1,'x') RETURNING id`,
      [`calllog-link-${String(process.pid)}@example.com`],
    );
    accountId = Number(acc.rows[0]?.id);
    const prod = await pool.query<{ id: string }>(
      `INSERT INTO product (account_id, name, ldong_regn_cd, start_date, nights, transport, planned_at)
       VALUES ($1,'호출 잇기 검증','51', DATE '2026-10-13', 1, 'CAR', now()) RETURNING id`,
      [accountId],
    );
    const run = await pool.query<{ id: string }>(
      `INSERT INTO audit_run (product_id, executed_at, ruleset_version, target_count, weight_snapshot)
       VALUES ($1, now(), '1.0.0', 1, '{}'::jsonb) RETURNING id`,
      [prod.rows[0]?.id],
    );
    runId = Number(run.rows[0]?.id);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM api_call_log WHERE quota_date = $1`, [DAY]);
    // 상품 · 실행은 계정에 매달려 있다 (ON DELETE CASCADE)
    await pool.query(`DELETE FROM account WHERE id = $1`, [accountId]);
    await pool.end();
  });

  it('🔴 검수가 낸 호출에 audit_run_id 가 붙는다 — 검수 1건당 호출 수를 센다', async () => {
    const scoped = new RunScopedCallLogger(logs);
    // 어댑터는 이 약속을 `void ... .catch()` 로 흘려보낸다. 기다리는 것은 `linkTo` 다
    void scoped.record(entry('scoped-a'));
    void scoped.record(entry('scoped-b'));

    expect(await scoped.linkTo(runId)).toBe(2);
    expect(await rowsOfDay()).toEqual([['scoped-a', runId], ['scoped-b', runId]]);
  });

  it('검수 밖 호출은 잇지 않는다 — 시간 창으로 긁지 않는다', async () => {
    const scoped = new RunScopedCallLogger(logs);
    void scoped.record(entry('scoped-c'));
    // 같은 날 같은 시각이지만 이 검수가 낸 것이 아니다 (배치 · 기획 화면 호출)
    await logs.record(entry('outside'));

    expect(await scoped.linkTo(runId)).toBe(1);
    const rows = await rowsOfDay();
    expect(rows.find(([op]) => op === 'scoped-c')?.[1]).toBe(runId);
    expect(rows.find(([op]) => op === 'outside')?.[1]).toBeNull();
  });

  it('두 번 이어도 결과가 같다 — 이미 붙은 행은 건드리지 않는다', async () => {
    const scoped = new RunScopedCallLogger(logs);
    void scoped.record(entry('scoped-d'));

    expect(await scoped.linkTo(runId)).toBe(1);
    expect(await scoped.linkTo(runId)).toBe(0);
  });
});
