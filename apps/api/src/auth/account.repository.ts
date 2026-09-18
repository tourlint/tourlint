import type { Pool, PoolClient } from 'pg';
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

/**
 * 계정 단위 기본 데이터 (DR-CF-002). **회원가입과 데모 시드가 이 함수 하나를 쓴다.**
 *
 * `user_setting` 한 행뿐이다. R10 프로파일 · 체류시간 · 실내 · 야외는 모든 계정이 같은 표준이라
 * 판정이 `@tourlint/shared` 시드를 직접 읽고, 계정마다 표를 복사하지 않는다(FR-OP-021 ·
 * 2026-09-15). 복사하던 표 3종은 릴리즈 2 에서 지운다.
 *
 * `ON CONFLICT DO NOTHING` 이라 **이미 있는 계정에 다시 불러도 안전하다** — 사용자가 고친
 * 회사 기준을 시드가 덮지 않는다.
 */
export async function seedAccountDefaults(client: ClientLike, accountId: number): Promise<void> {
  await client.query(
    `INSERT INTO user_setting (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING`,
    [accountId],
  );
}

/** 트랜잭션 클라이언트와 풀 양쪽을 받는다 — 가입은 트랜잭션 안, 데모 시드는 풀로 부른다 */
export interface ClientLike {
  query(sql: string, params?: readonly unknown[]): Promise<unknown>;
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

  /** 계정과 기본 설정을 같은 트랜잭션에서 생성한다. 중복은 서비스가 일반 가입 오류로 바꾼다. */
  async create(email: string, passwordHash: string, isDemo = false): Promise<AccountRow> {
    return withTransaction(this.pool, (client) => this.createWithClient(client, email, passwordHash, isDemo));
  }

  async createWithClient(client: PoolClient, email: string, passwordHash: string, isDemo = false): Promise<AccountRow> {
    const { rows } = await client.query<{ id: string; email: string; is_demo: boolean }>(
      `INSERT INTO account (email, password_hash, is_demo)
       VALUES ($1, $2, $3)
       RETURNING id, email, is_demo`,
      [email, passwordHash, isDemo],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('계정 생성 결과가 비어 있다');
    await seedAccountDefaults(client, Number(row.id));
    return { id: Number(row.id), email: row.email, passwordHash, isDemo: row.is_demo };
  }
}
