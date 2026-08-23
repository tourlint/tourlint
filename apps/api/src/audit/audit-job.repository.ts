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
