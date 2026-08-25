import type { Pool } from 'pg';
import { withTransaction } from '../persistence/db';

/**
 * 계정 읽기·쓰기.
 *
 * 수집하는 개인정보는 이메일 1종뿐이다. 이름·연락처·소속·위치 컬럼을 더하지 않는다
 * (PM-AC-009 · DR-PR-006).
 */
export interface AccountRow {
  id: number;
  email: string;
  passwordHash: string;
  isDemo: boolean;
}

export class AccountRepository {
  constructor(private readonly pool: Pool) {}

  async findByEmail(email: string): Promise<AccountRow | null> {
    const { rows } = await this.pool.query<{ id: string; email: string; password_hash: string; is_demo: boolean }>(
      `SELECT id, email, password_hash, is_demo FROM account WHERE email = $1`,
      [email],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return { id: Number(row.id), email: row.email, passwordHash: row.password_hash, isDemo: row.is_demo };
  }

  /**
   * 계정을 만든다. 같은 트랜잭션에서 `user_setting` 1행도 함께 만든다 — 설정이 없는
   * 계정을 허용하지 않는다 (DR-CF-002). 나머지 기본 데이터(체류시간 59행 · 실내외 59행
   * · 기대 프로파일)는 중분류 기준표가 확정되면 이 트랜잭션에 함께 넣는다.
   *
   * 이메일 중복이면 UNIQUE 제약(23505)이 잡는다. 서비스 계층이 이걸 "가입할 수 없음"
   * 으로만 바꿔 던져, 이미 가입된 계정인지 노출하지 않는다 (EX-SY-007).
   */
  async create(email: string, passwordHash: string, isDemo = false): Promise<AccountRow> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<{ id: string; email: string; is_demo: boolean }>(
        `INSERT INTO account (email, password_hash, is_demo)
         VALUES ($1, $2, $3)
         RETURNING id, email, is_demo`,
        [email, passwordHash, isDemo],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('계정 생성 결과가 비어 있다');
      await client.query(`INSERT INTO user_setting (account_id) VALUES ($1)`, [row.id]);
      return { id: Number(row.id), email: row.email, passwordHash, isDemo: row.is_demo };
    });
  }
}
