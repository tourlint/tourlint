import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

/**
 * 세션 읽기·쓰기.
 *
 * 세션 id 는 32바이트 난수(hex)다. 추측·열거가 불가능해야 쿠키 탈취 외의 경로로는
 * 남의 세션이 되지 않는다.
 */
export interface SessionAccount {
  accountId: number;
  email: string;
  isDemo: boolean;
}

export class SessionRepository {
  constructor(private readonly pool: Pool) {}

  async create(accountId: number, ttlMs: number): Promise<{ id: string; expiresAt: Date }> {
    const id = randomBytes(32).toString('hex');
    const { rows } = await this.pool.query<{ expires_at: Date }>(
      `INSERT INTO session (id, account_id, expires_at)
       VALUES ($1, $2, now() + ($3::bigint * interval '1 millisecond'))
       RETURNING expires_at`,
      [id, accountId, ttlMs],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('세션 생성 결과가 비어 있다');
    return { id, expiresAt: row.expires_at };
  }

  /**
   * 세션을 되찾으면서 만료 시계를 뒤로 민다 (슬라이딩 세션).
   *
   * 만료 검사(`expires_at > now()`)와 연장을 한 UPDATE 로 원자적으로 처리한다. 활동이
   * 있는 한 만료가 오지 않고, 방치했을 때만 만료돼 재인증으로 간다 (PM-AC-006) — 그래서
   * TTL 은 '로그인 후 7일'이 아니라 '마지막 활동 후 7일'인 유휴 타임아웃이 된다.
   * 만료·부재면 갱신 대상이 없어 0행 → `null`.
   *
   * 인증 요청마다 세션 행을 한 번 쓴다. 이 서비스 트래픽 규모에선 부담이 아니고, 필요해지면
   * 'TTL 절반 경과 시에만 갱신'으로 쓰기를 줄이면 된다.
   */
  async find(sessionId: string, ttlMs: number): Promise<SessionAccount | null> {
    const { rows } = await this.pool.query<{ account_id: string; email: string; is_demo: boolean }>(
      `UPDATE session s
          SET expires_at = now() + ($2::bigint * interval '1 millisecond')
         FROM account a
        WHERE s.id = $1 AND a.id = s.account_id AND s.expires_at > now()
      RETURNING a.id AS account_id, a.email, a.is_demo`,
      [sessionId, ttlMs],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return { accountId: Number(row.account_id), email: row.email, isDemo: row.is_demo };
  }

  async delete(sessionId: string): Promise<void> {
    await this.pool.query(`DELETE FROM session WHERE id = $1`, [sessionId]);
  }
}
