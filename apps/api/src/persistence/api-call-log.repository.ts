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
    await this.recordReturningId(entry);
  }

  /**
   * 쓰고 그 행의 id 를 준다. `RunScopedCallLogger` 가 검수 하나가 낸 호출을 모으는 데 쓴다.
   *
   * 검수를 시작할 때는 `audit_run` 행이 아직 없다 — 집계가 끝나야 INSERT 된다. 그래서
   * 호출 시점에는 `audit_run_id` 를 채울 수 없고, 끝난 뒤 이 id 들로 이어 붙인다 (#466).
   */
  async recordReturningId(entry: ApiCallLogEntry): Promise<number | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO api_call_log
         (provider, operation, called_at, status, http_status, result_code, latency_ms, audit_run_id, quota_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        entry.provider, entry.operation, entry.calledAt, entry.status,
        entry.httpStatus, entry.resultCode, entry.latencyMs, entry.auditRunId,
        // 예산의 하루 경계는 한국 시간이다. UTC 로 세면 오후 9시 이후 호출이 다음 날로 넘어간다
        localDateKey(entry.calledAt),
      ],
    );
    const id = rows[0]?.id;
    return id === undefined ? null : Number(id);
  }

  /**
   * 이미 쓴 행을 검수 실행에 이어 붙인다 (#466).
   *
   * **이미 붙은 행은 건드리지 않는다** (`audit_run_id IS NULL` 조건). 같은 id 로 두 번
   * 불려도 결과가 같아야 한다.
   */
  async linkToRun(ids: readonly number[], auditRunId: number): Promise<number> {
    if (ids.length === 0) return 0;
    const { rowCount } = await this.pool.query(
      `UPDATE api_call_log SET audit_run_id = $1 WHERE id = ANY($2::bigint[]) AND audit_run_id IS NULL`,
      [auditRunId, ids],
    );
    return rowCount ?? 0;
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

/**
 * 검수 하나가 낸 호출을 모아 두는 로거 (#466).
 *
 * 쓰기 자체는 그대로 즉시 나간다 — 버퍼에 담았다가 끝에 쓰면 증빙이 프로세스와 함께
 * 사라지고, 예산 집계가 진행 중인 검수의 호출을 못 센다. 여기서 모으는 것은 **행 id 뿐**
 * 이고, 검수가 저장된 뒤 `linkTo` 가 한 번에 이어 붙인다.
 *
 * 검수가 중간에 죽으면 이어 붙이지 않는다 — 행은 `audit_run_id NULL` 로 남는다. 종전과
 * 같은 상태이고, 없는 실행에 호출을 달지 않는다 (설계 원칙 4).
 */
export class RunScopedCallLogger implements ApiCallLogger {
  private readonly ids: number[] = [];
  private readonly pending: Promise<unknown>[] = [];

  constructor(private readonly inner: PgApiCallLogger) {}

  record(entry: ApiCallLogEntry): Promise<void> {
    const done = this.inner.recordReturningId(entry).then((id) => {
      if (id !== null) this.ids.push(id);
    });
    // 호출자는 이 약속을 `void ... .catch()` 로 흘려보낸다. 끝을 기다리는 것은 `linkTo` 다
    this.pending.push(done);
    return done;
  }

  /** 모은 행을 실행에 잇는다. 아직 안 끝난 쓰기를 먼저 기다린다 */
  async linkTo(auditRunId: number): Promise<number> {
    await Promise.allSettled(this.pending);
    return this.inner.linkToRun(this.ids, auditRunId);
  }
}
