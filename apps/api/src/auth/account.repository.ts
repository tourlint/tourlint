import type { Pool } from 'pg';
import { DWELL_MINUTES_SEED, INDOOR_OUTDOOR_SEED, TARGET_PROFILE_SEED } from '@tourlint/shared';
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
 * 두 곳에 같은 INSERT 를 두었더니 실제로 갈렸다 — 데모 시드가 `user_setting` 만 넣고
 * 나머지 셋을 빠뜨려 운영 데모 계정이 `target_profile 0/63` 인 채로 돌았다. 그 상태에서는
 * R10 이 기대 프로파일을 못 찾아 **판정 대신 확인 불가**를 내고(TP-03 이 29점이 아니라
 * 27점), R09 실내·야외와 체류시간 보완이 계정 설정 대신 상수로 돌아간다 (이슈 #310).
 *
 * `ON CONFLICT DO NOTHING` 이라 **이미 있는 계정에 다시 불러도 안전하다** — 사용자가 설정
 * 화면에서 고친 값을 시드가 덮지 않는다.
 */
export async function seedAccountDefaults(client: ClientLike, accountId: number): Promise<void> {
  await client.query(
    `INSERT INTO user_setting (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING`,
    [accountId],
  );
  /*
   * 63행을 한 번에 넣는다. `expected_lcls2` 는 배열의 배열인데 `unnest` 가 다차원 배열을
   * **평탄화**해 버려서 그대로는 넘길 수 없다 — 쉼표로 이어 보내고 SQL 에서 다시 가른다.
   * 중분류 코드는 영숫자뿐이라 쉼표가 값에 섞이지 않는다.
   */
  await client.query(
    `INSERT INTO target_profile (account_id, target_key, concept_key, expected_lcls2, expects_night)
     SELECT $1, t.target_key, t.concept_key, string_to_array(t.codes, ','), t.expects_night
       FROM unnest($2::text[], $3::text[], $4::text[], $5::boolean[])
         AS t(target_key, concept_key, codes, expects_night)
     ON CONFLICT (account_id, target_key, concept_key) DO NOTHING`,
    [
      accountId,
      TARGET_PROFILE_SEED.map((p) => p.targetKey),
      TARGET_PROFILE_SEED.map((p) => p.conceptKey),
      TARGET_PROFILE_SEED.map((p) => p.expectedLcls2.join(',')),
      TARGET_PROFILE_SEED.map((p) => p.expectsNight),
    ],
  );
  await client.query(
    `INSERT INTO indoor_outdoor_map (account_id, lcls_systm2, space_type)
     SELECT $1, t.code, t.kind FROM unnest($2::text[], $3::text[]) AS t(code, kind)
     ON CONFLICT (account_id, lcls_systm2) DO NOTHING`,
    [accountId, Object.keys(INDOOR_OUTDOOR_SEED), Object.values(INDOOR_OUTDOOR_SEED)],
  );
  await client.query(
    `INSERT INTO dwell_default (account_id, lcls_systm2, minutes)
     SELECT $1, t.code, t.minutes FROM unnest($2::text[], $3::int[]) AS t(code, minutes)
     ON CONFLICT (account_id, lcls_systm2) DO NOTHING`,
    [accountId, Object.keys(DWELL_MINUTES_SEED), Object.values(DWELL_MINUTES_SEED)],
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
