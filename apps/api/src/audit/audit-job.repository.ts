import type { Pool } from 'pg';

/**
 * 검수 작업 큐 (`audit_job`).
 *
 * 큐를 DB 에 두는 이유 — 화면을 벗어났다 돌아와도 `jobId` 로 진행 상태를 이어서 보여줘야
 * 하고(EX-AU-003), 같은 상품에 두 번 실행이 겹치면 안 되기 때문이다(EX-AU-004).
 * **`uq_job_active` 부분 인덱스가 그 중복을 DB 에서 막는다.**
 */

export const JOB_STATUS = ['QUEUED', 'RUNNING', 'DONE', 'FAILED'] as const;
export type JobStatus = (typeof JOB_STATUS)[number];

export const TRIGGER_TYPE = ['INITIAL', 'MANUAL', 'PATCH', 'BATCH'] as const;
export type TriggerType = (typeof TRIGGER_TYPE)[number];

export interface AuditJob {
  readonly id: number;
  readonly productId: number;
  readonly status: JobStatus;
  readonly triggerType: TriggerType;
  readonly progressDone: number;
  readonly progressTotal: number;
  readonly auditRunId: number | null;
  readonly errorCode: string | null;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
}

interface JobRow {
  id: string;
  product_id: string;
  status: JobStatus;
  trigger_type: TriggerType;
  progress_done: number;
  progress_total: number;
  audit_run_id: string | null;
  error_code: string | null;
  created_at: Date;
  finished_at: Date | null;
}

const COLUMNS = `id, product_id, status, trigger_type, progress_done, progress_total,
                 audit_run_id, error_code, created_at, finished_at`;

/**
 * 검수 작업의 기한 (EX-AU-002 · NF-AV-008). 만든 지 이만큼 지나도 `QUEUED` · `RUNNING` 이면
 * 멈춘 것이다. 한 건은 20초 안쪽으로 끝난다(NF-PF-001) — 30분은 넉넉한 기한이다.
 */
export const AUDIT_JOB_TIMEOUT_MS = 30 * 60 * 1000;

/** 기한을 넘긴 진행 중 작업인가 */
export function isStale(job: AuditJob, now: Date): boolean {
  const active = job.status === 'QUEUED' || job.status === 'RUNNING';
  return active && now.getTime() - job.createdAt.getTime() > AUDIT_JOB_TIMEOUT_MS;
}

export class AuditJobRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * 진행 중인 작업이 있으면 **그것을 돌려주고 새로 만들지 않는다** (EX-AU-004).
   *
   * 조회 후 INSERT 사이에 다른 요청이 끼어들 수 있으므로 `uq_job_active` 위반도 같은 뜻으로
   * 받는다. 경쟁 상태를 애플리케이션 락이 아니라 DB 제약으로 푼다.
   */
  async enqueue(productId: number, triggerType: TriggerType): Promise<{ job: AuditJob; created: boolean }> {
    const active = await this.findActive(productId);
    if (active !== null) return { job: active, created: false };

    try {
      const { rows } = await this.pool.query<JobRow>(
        `INSERT INTO audit_job (product_id, status, trigger_type) VALUES ($1, 'QUEUED', $2)
         RETURNING ${COLUMNS}`,
        [productId, triggerType],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('audit_job 을 만들지 못했다');
      return { job: toJob(row), created: true };
    } catch (e) {
      if (isUniqueViolation(e)) {
        const existing = await this.findActive(productId);
        if (existing !== null) return { job: existing, created: false };
      }
      throw e;
    }
  }

  async findActive(productId: number): Promise<AuditJob | null> {
    const { rows } = await this.pool.query<JobRow>(
      `SELECT ${COLUMNS} FROM audit_job
        WHERE product_id = $1 AND status IN ('QUEUED','RUNNING')
        ORDER BY id DESC LIMIT 1`,
      [productId],
    );
    return rows[0] === undefined ? null : toJob(rows[0]);
  }

  async findById(jobId: number): Promise<AuditJob | null> {
    const { rows } = await this.pool.query<JobRow>(`SELECT ${COLUMNS} FROM audit_job WHERE id = $1`, [jobId]);
    return rows[0] === undefined ? null : toJob(rows[0]);
  }

  /**
   * 큐에서 다음 작업 한 건을 **집어 오면서 동시에 `RUNNING` 으로 바꾼다.**
   *
   * 고르기와 표시가 두 문장으로 갈려 있으면 그 사이에 다른 소비자가 같은 행을 고른다 —
   * 상품이 다른 두 요청이 동시에 들어오면 각자 `drain()` 을 돌리므로 실제로 겹칠 수 있다.
   * 한 문장으로 묶고 `SKIP LOCKED` 로 남이 잡은 행을 건너뛴다.
   *
   * `progress_total` 은 여기서 건드리지 않는다. 항목 수는 아직 안 셌고, 기본값 0 이라
   * `ck_job_progress` 도 만족한다 — 세고 나서 `markRunning` 이 채운다.
   */
  async claimNext(): Promise<{ id: number; productId: number } | null> {
    const { rows } = await this.pool.query<{ id: string; product_id: string }>(
      `UPDATE audit_job SET status = 'RUNNING'
        WHERE id = (SELECT id FROM audit_job WHERE status = 'QUEUED'
                     ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING id, product_id`,
    );
    const row = rows[0];
    return row === undefined ? null : { id: Number(row.id), productId: Number(row.product_id) };
  }

  async markRunning(jobId: number, total: number): Promise<void> {
    await this.pool.query(
      `UPDATE audit_job SET status = 'RUNNING', progress_total = $2, progress_done = 0 WHERE id = $1`,
      [jobId, total],
    );
  }

  /**
   * 진행률을 갱신한다. `progress_done <= progress_total` 은 DB 가 강제한다.
   *
   * **뒤로 가지 않는다.** 관광지 단위 병렬 조회는 완료 순서가 정해져 있지 않아 갱신이
   * 뒤섞여 도착한다 — 그냥 덮어쓰면 3/3 다음에 2/3 가 찍혀 폴링 화면이 뒷걸음질한다.
   *
   * `LEAST` 안의 파라미터는 Postgres 가 타입을 추론하지 못해 text 로 떨어뜨리므로 캐스트한다.
   */
  async updateProgress(jobId: number, done: number, total: number): Promise<void> {
    await this.pool.query(
      `UPDATE audit_job
          SET progress_done = GREATEST(progress_done, LEAST($2::int, $3::int)),
              progress_total = $3::int
        WHERE id = $1`,
      [jobId, done, total],
    );
  }

  async markDone(jobId: number, auditRunId: number, finishedAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE audit_job SET status = 'DONE', audit_run_id = $2, finished_at = $3 WHERE id = $1`,
      [jobId, auditRunId, finishedAt],
    );
  }

  /**
   * 기한을 넘긴 작업을 `FAILED`(`AUDIT_TIMEOUT`)로 닫는다 (EX-AU-002 · #772).
   *
   * 작업을 돌리던 프로세스가 재배포 · 재시작으로 끝나면 그 행이 `RUNNING` 으로 남는다.
   * 되살리는 코드가 없어서 그 상품은 재검수가 남은 작업만 기다리고 확정은 늘 409 였다.
   *
   * **만든 지 기한이 지난 것만** 닫는다. 재배포 중에는 옛 컨테이너가 아직 검수를 돌리고
   * 있어서, 새 컨테이너가 시각 조건 없이 닫으면 살아 있는 작업을 끊는다.
   */
  async closeStale(now: Date): Promise<readonly number[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `UPDATE audit_job SET status = 'FAILED', error_code = 'AUDIT_TIMEOUT', finished_at = $1
        WHERE status IN ('QUEUED','RUNNING') AND created_at < $2
        RETURNING id`,
      [now, new Date(now.getTime() - AUDIT_JOB_TIMEOUT_MS)],
    );
    return rows.map((row) => Number(row.id));
  }

  /** 실패해도 진행률은 남긴다 — 어디까지 갔는지가 사용자에게 정보다 */
  async markFailed(jobId: number, errorCode: string, finishedAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE audit_job SET status = 'FAILED', error_code = $2, finished_at = $3 WHERE id = $1`,
      [jobId, errorCode, finishedAt],
    );
  }
}

function toJob(row: JobRow): AuditJob {
  return {
    id: Number(row.id),
    productId: Number(row.product_id),
    status: row.status,
    triggerType: row.trigger_type,
    progressDone: row.progress_done,
    progressTotal: row.progress_total,
    auditRunId: row.audit_run_id === null ? null : Number(row.audit_run_id),
    errorCode: row.error_code,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

/** Postgres unique_violation */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}
