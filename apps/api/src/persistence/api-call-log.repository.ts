import type { Pool } from 'pg';
import type { ApiCallLogEntry, ApiCallLogger, CallProvider, DailyCallCounter } from '../external/api-call-log';
import { localDateKey } from '../external/api-call-log';

/**
 * 호출 로그를 DB 에 남긴다 (`api_call_log` · FR-OP-001 · EI-CM-006).
 *
 * **이 표는 공모전 API 활용 증빙 자료다.** 개발 기간 전체를 보존하며 임의로 정리하지 않는다
 * (DR-LC-004). 메모리 구현은 프로세스가 죽으면 사라져 증빙이 되지 않는다.
 *
 * 쓰기가 실패해도 검수를 멈추지 않는다 — 호출자(`KtoClient`)가 삼킨다. 증빙 유실은
 * 조용해도 되지만 서비스가 멈추면 안 된다.
 */
export class PgApiCallLogger implements ApiCallLogger, DailyCallCounter {
  constructor(private readonly pool: Pool) {}

  async record(entry: ApiCallLogEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO api_call_log
         (provider, operation, called_at, status, http_status, result_code, latency_ms, audit_run_id, quota_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        entry.provider, entry.operation, entry.calledAt, entry.status,
        entry.httpStatus, entry.resultCode, entry.latencyMs, entry.auditRunId,
        // 예산의 하루 경계는 한국 시간이다. UTC 로 세면 오후 9시 이후 호출이 다음 날로 넘어간다
        localDateKey(entry.calledAt),
      ],
    );
  }

  async countToday(provider: CallProvider, now: Date): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM api_call_log WHERE provider = $1 AND quota_date = $2`,
      [provider, localDateKey(now)],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * 일자별 · 오퍼레이션별 호출 집계 (FR-OP-007 · 활용 증빙).
   *
   * 개별 호출 행을 그대로 내보내지 않고 집계만 준다. 증빙에 필요한 것은 "언제 무엇을 몇 번
   * 불렀나" 지 호출 하나하나가 아니고, 행을 그대로 흘리면 나중에 파라미터 컬럼이 생겼을 때
   * 조용히 같이 새어 나간다 (PM-SC-005 · NF-OB-002).
   *
   * 인증키와 요청 파라미터는 애초에 이 표에 없다 (`api_call_log` 스키마).
   */
  async dailyBreakdown(range: {
    readonly from: string;
    readonly to: string;
    readonly provider?: CallProvider;
  }): Promise<readonly CallUsageRow[]> {
    const { rows } = await this.pool.query<RawUsageRow>(
      `SELECT quota_date, provider, operation,
              count(*)::text                                        AS total,
              count(*) FILTER (WHERE status = 'OK')::text            AS ok,
              count(*) FILTER (WHERE status = 'FAIL')::text          AS fail,
              count(*) FILTER (WHERE status = 'TIMEOUT')::text       AS timeout,
              round(avg(latency_ms))::text                           AS avg_latency
         FROM api_call_log
        WHERE quota_date BETWEEN $1::date AND $2::date
          AND ($3::text IS NULL OR provider = $3)
        GROUP BY quota_date, provider, operation
        ORDER BY quota_date DESC, count(*) DESC, operation ASC`,
      [range.from, range.to, range.provider ?? null],
    );
    return rows.map((r) => ({
      quotaDate: typeof r.quota_date === 'string' ? r.quota_date.slice(0, 10) : isoDate(r.quota_date),
      provider: r.provider,
      operation: r.operation,
      count: Number(r.total),
      okCount: Number(r.ok),
      failCount: Number(r.fail),
      timeoutCount: Number(r.timeout),
      avgLatencyMs: Number(r.avg_latency ?? 0),
    }));
  }

  /** 위젯의 "오퍼레이션별 상위 5개" (FR-OP-005) */
  async topOperations(provider: CallProvider, now: Date, limit = 5): Promise<{ operation: string; count: number }[]> {
    const { rows } = await this.pool.query<{ operation: string; n: string }>(
      `SELECT operation, count(*)::text AS n FROM api_call_log
        WHERE provider = $1 AND quota_date = $2
        GROUP BY operation ORDER BY count(*) DESC, operation ASC LIMIT $3`,
      [provider, localDateKey(now), limit],
    );
    return rows.map((r) => ({ operation: r.operation, count: Number(r.n) }));
  }
}

export interface CallUsageRow {
  readonly quotaDate: string;
  readonly provider: CallProvider;
  readonly operation: string;
  readonly count: number;
  readonly okCount: number;
  readonly failCount: number;
  readonly timeoutCount: number;
  readonly avgLatencyMs: number;
}

interface RawUsageRow {
  quota_date: Date | string;
  provider: CallProvider;
  operation: string;
  total: string;
  ok: string;
  fail: string;
  timeout: string;
  avg_latency: string | null;
}

/** DATE 컬럼이 Date 로 오면 시간대 때문에 하루가 밀린다. 지역 필드로 읽는다 */
function isoDate(value: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}
