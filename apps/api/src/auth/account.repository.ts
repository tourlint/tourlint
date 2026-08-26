import type { Pool } from 'pg';
import { TARGET_PROFILE_SEED } from '@tourlint/shared';
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
   * 계정을 만든다. 같은 트랜잭션에서 `user_setting` 1행과 **기대 콘텐츠 프로파일 63행**을
   * 함께 만든다 — 설정이 없는 계정을 허용하지 않는다 (DR-CF-002).
   *
   * 프로파일이 하나라도 비면 그 조합의 상품이 R10 을 영영 확인 불가로 남긴다. 그래서
   * 타깃 7 × 콘셉트 9 를 빠짐없이 넣는다 (FR-RU-100).
   *
   * 체류시간 59행 · 실내외 59행은 아직이다. 그 둘은 값이 판정을 바꿔서 따로 정해야 한다.
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
      /*
       * 63행을 한 번에 넣는다. `expected_lcls2` 는 배열의 배열인데 `unnest` 가 다차원
       * 배열을 **평탄화**해 버려서 그대로는 넘길 수 없다 — 쉼표로 이어 보내고 SQL 에서
       * 다시 가른다. 중분류 코드는 영숫자뿐이라 쉼표가 값에 섞이지 않는다.
       */
      await client.query(
        `INSERT INTO target_profile (account_id, target_key, concept_key, expected_lcls2, expects_night)
         SELECT $1, t.target_key, t.concept_key, string_to_array(t.codes, ','), t.expects_night
           FROM unnest($2::text[], $3::text[], $4::text[], $5::boolean[])
             AS t(target_key, concept_key, codes, expects_night)`,
        [
          row.id,
          TARGET_PROFILE_SEED.map((p) => p.targetKey),
          TARGET_PROFILE_SEED.map((p) => p.conceptKey),
          TARGET_PROFILE_SEED.map((p) => p.expectedLcls2.join(',')),
          TARGET_PROFILE_SEED.map((p) => p.expectsNight),
        ],
      );
      return { id: Number(row.id), email: row.email, passwordHash, isDemo: row.is_demo };
    });
  }
}
