import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UsageService } from './usage.service';

/**
 * 호출 예산 · 활용 증빙 — 실 DB.
 *
 * 집계 쿼리라 가짜 커넥션으로는 아무것도 검증되지 않는다. `quota_date` 경계와 상태 3단이
 * 실제로 갈리는지를 본다.
 */

const URL = process.env.TEST_DATABASE_URL;
if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

describe.skipIf(URL === undefined)('UsageService', () => {
  let pool: Pool;
  let service: UsageService;
  /** 이 테스트가 넣은 행만 지운다. 호출 로그는 계정에 딸리지 않아 CASCADE 로 안 지워진다 */
  const MARKER = 'zz-usage-spec';

  beforeAll(() => {
    pool = new Pool({ connectionString: URL, max: 4 });
    service = new UsageService(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const seed = async (rows: readonly [string, string, string, string, number][]): Promise<void> => {
    for (const [quotaDate, provider, operation, status, latency] of rows) {
      await pool.query(
        `INSERT INTO api_call_log (provider, operation, called_at, quota_date, status, latency_ms)
         VALUES ($1,$2,$3::date + time '12:00', $3::date, $4, $5)`,
        [provider, operation, quotaDate, status, latency],
      );
    }
  };

  beforeEach(async () => {
    await pool.query(`DELETE FROM api_call_log WHERE operation LIKE $1`, [`${MARKER}%`]);
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM api_call_log WHERE operation LIKE $1`, [`${MARKER}%`]);
  });

  describe('예산 (FR-OP-005)', () => {
    // 과거 고정일. 미래 날짜를 쓰면 다른 스펙의 정리 쿼리에 쓸려 간다
  const NOW = new Date('2026-03-15T05:00:00Z'); // KST 14:00

    it('당일 공사 호출만 센다 — 카카오·LLM 은 별개 한도다', async () => {
      await seed([
        ['2026-03-15', 'KTO', `${MARKER}-a`, 'OK', 100],
        ['2026-03-15', 'KTO', `${MARKER}-b`, 'OK', 100],
        ['2026-03-15', 'KAKAO_MOBILITY', `${MARKER}-c`, 'OK', 100],
        ['2026-03-15', 'LLM', `${MARKER}-d`, 'OK', 100],
      ]);
      const view = await service.budget(NOW);
      expect(view.used).toBe(2);
      expect(view.quotaDate).toBe('2026-03-15');
    });

    it('전날 호출은 안 센다 — 예산 경계는 한국 시간 자정이다', async () => {
      await seed([
        ['2026-03-14', 'KTO', `${MARKER}-old`, 'OK', 100],
        ['2026-03-15', 'KTO', `${MARKER}-new`, 'OK', 100],
      ]);
      expect((await service.budget(NOW)).used).toBe(1);
    });

    it('초기화 시각은 다음 날 한국 시간 자정이다', async () => {
      expect((await service.budget(NOW)).resetAt).toBe('2026-03-16T00:00:00+09:00');
    });

    it('상위 오퍼레이션을 많이 부른 순으로 준다', async () => {
      await seed([
        ['2026-03-15', 'KTO', `${MARKER}-many`, 'OK', 100],
        ['2026-03-15', 'KTO', `${MARKER}-many`, 'OK', 100],
        ['2026-03-15', 'KTO', `${MARKER}-few`, 'OK', 100],
      ]);
      const top = (await service.budget(NOW)).topOperations;
      expect(top[0]).toEqual({ operation: `${MARKER}-many`, count: 2 });
    });

    it('아무것도 안 불렀으면 0 이고 NORMAL 이다', async () => {
      const view = await service.budget(new Date('2030-01-01T05:00:00Z'));
      expect(view.used).toBe(0);
      expect(view.state).toBe('NORMAL');
      expect(view.batchAutoStopped).toBe(false);
    });
  });

  describe('활용 증빙 (FR-OP-007)', () => {
    const NOW = new Date('2026-03-15T05:00:00Z');

    it('일자별 · 오퍼레이션별로 접고 상태를 나눠 센다', async () => {
      await seed([
        ['2026-03-15', 'KTO', `${MARKER}-op`, 'OK', 100],
        ['2026-03-15', 'KTO', `${MARKER}-op`, 'FAIL', 200],
        ['2026-03-15', 'KTO', `${MARKER}-op`, 'TIMEOUT', 300],
      ]);
      const view = await service.calls({ from: '2026-03-15', to: '2026-03-15', now: NOW });
      const row = view.content.find((r) => r.operation === `${MARKER}-op`);
      expect(row).toMatchObject({ count: 3, okCount: 1, failCount: 1, timeoutCount: 1 });
      expect(row?.avgLatencyMs).toBe(200);
    });

    it('구간 밖 호출은 빠진다', async () => {
      await seed([
        ['2026-03-10', 'KTO', `${MARKER}-out`, 'OK', 100],
        ['2026-03-15', 'KTO', `${MARKER}-in`, 'OK', 100],
      ]);
      const view = await service.calls({ from: '2026-03-15', to: '2026-03-15', now: NOW });
      const ops = view.content.map((r) => r.operation);
      expect(ops).toContain(`${MARKER}-in`);
      expect(ops).not.toContain(`${MARKER}-out`);
    });

    it('제공자로 거를 수 있다', async () => {
      await seed([
        ['2026-03-15', 'KTO', `${MARKER}-kto`, 'OK', 100],
        ['2026-03-15', 'KMA', `${MARKER}-kma`, 'OK', 100],
      ]);
      const view = await service.calls({ from: '2026-03-15', to: '2026-03-15', provider: 'KMA', now: NOW });
      expect(view.content.every((r) => r.provider === 'KMA')).toBe(true);
    });

    it('기본 구간은 오늘 포함 최근 7일이다', async () => {
      const view = await service.calls({ now: NOW });
      expect(view.range).toEqual({ from: '2026-03-09', to: '2026-03-15' });
    });

    it('🔴 인증키나 파라미터가 응답에 없다 — 이 표가 증빙이라 새면 안 된다', async () => {
      await seed([['2026-03-15', 'KTO', `${MARKER}-leak`, 'OK', 100]]);
      const view = await service.calls({ from: '2026-03-15', to: '2026-03-15', now: NOW });
      const serialized = JSON.stringify(view);
      expect(serialized).not.toMatch(/serviceKey|apiKey|Authorization|password/i);
      // 개별 호출 행이 아니라 집계다 — id 나 called_at 이 나가면 행을 그대로 흘린 것이다
      expect(serialized).not.toMatch(/"id"|"calledAt"|"httpStatus"/);
    });
  });
});
