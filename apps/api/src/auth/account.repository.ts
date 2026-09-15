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

  /**
   * 계정을 만든다. 같은 트랜잭션에서 `user_setting` 1행과 **기대 콘텐츠 프로파일 63행**을
   * 함께 만든다 — 설정이 없는 계정을 허용하지 않는다 (DR-CF-002).
   *
   * 프로파일이 하나라도 비면 그 조합의 상품이 R10 을 영영 확인 불가로 남긴다. 그래서
   * 타깃 7 × 콘셉트 9 를 빠짐없이 넣는다 (FR-RU-100).
   *
   * 실내외 59행과 체류시간 47행도 함께 넣는다 (2026.08.27). 체류시간이 47행인 것은
   * 숙박 6종과 추천코스 6종을 뺀 수다 — 숙박은 입실 · 퇴실만 해석하고(FR-AU-011),
   * 추천코스는 일정 항목 유형이 아니다.
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
      await seedAccountDefaults(client, Number(row.id));
      return { id: Number(row.id), email: row.email, passwordHash, isDemo: row.is_demo };
    });
  }
}
