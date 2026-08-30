import type { Pool } from 'pg';

/**
 * 검수 계열 리소스의 **소유자 대조** (PM-DA-001 ~ 004 · EX-SY-003).
 *
 * `AuditController` 는 `productId` · `runId` · `jobId` · `findingId` ·
 * `patchApplicationId` 를 계정 대조 없이 받고 있었다. 로그인만 하면 남의 id 로
 * 검수 결과를 보고 무시 처리까지 할 수 있었다 — PM-DA-002 의 인수조건이
 * "계정 A가 계정 B의 `audit_run` ID로 검수 결과를 조회하면 거부된다" 다.
 *
 * ## 왜 저장소에 모으는가
 *
 * 서비스 메서드마다 `accountId` 를 흘려 넣으면 내부 호출 경로(배치 · 재검수)까지
 * 전부 바뀐다. 배치에는 계정이 없다 — 전 계정을 돈다. 진입점에서만 막는다.
 *
 * ## 전부 같은 모양이다
 *
 * 모든 리소스가 `product` 를 통해서만 계정에 매인다. 조인 한 번으로 끝나고,
 * **없는 것과 남의 것을 구분하지 않는다** — 둘 다 `false` 이고 호출자가 404 를 낸다.
 */
export class AuditOwnershipRepository {
  constructor(private readonly pool: Pool) {}

  async product(productId: number, accountId: number): Promise<boolean> {
    return this.exists(
      'SELECT 1 FROM product WHERE id = $1 AND account_id = $2',
      productId, accountId,
    );
  }

  async run(auditRunId: number, accountId: number): Promise<boolean> {
    return this.exists(
      `SELECT 1 FROM audit_run r JOIN product p ON p.id = r.product_id
        WHERE r.id = $1 AND p.account_id = $2`,
      auditRunId, accountId,
    );
  }

  async job(jobId: number, accountId: number): Promise<boolean> {
    return this.exists(
      `SELECT 1 FROM audit_job j JOIN product p ON p.id = j.product_id
        WHERE j.id = $1 AND p.account_id = $2`,
      jobId, accountId,
    );
  }

  async finding(findingId: number, accountId: number): Promise<boolean> {
    return this.exists(
      `SELECT 1 FROM finding f
         JOIN audit_run r ON r.id = f.audit_run_id
         JOIN product p ON p.id = r.product_id
        WHERE f.id = $1 AND p.account_id = $2`,
      findingId, accountId,
    );
  }

  async patchApplication(id: number, accountId: number): Promise<boolean> {
    return this.exists(
      `SELECT 1 FROM patch_application a JOIN product p ON p.id = a.product_id
        WHERE a.id = $1 AND p.account_id = $2`,
      id, accountId,
    );
  }

  private async exists(sql: string, id: number, accountId: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(sql, [id, accountId]);
    return (rowCount ?? 0) > 0;
  }
}
