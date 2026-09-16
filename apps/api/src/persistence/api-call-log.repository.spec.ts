import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALL_PROVIDER as SHARED_CALL_PROVIDER } from '@tourlint/shared';
import { CALL_PROVIDER, type ApiCallLogEntry, type ApiCallLogger } from '../external/api-call-log';
import { KtoClient } from '../external/kto/kto.client';
import type { KtoParams, KtoTransport, KtoTransportResult } from '../external/kto/transport';
import { PgApiCallLogger } from './api-call-log.repository';

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
