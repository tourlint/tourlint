import type { Pool } from 'pg';
import type { TargetProfileLookup, TargetProfileRow } from '../audit/audit-runner';

/**
 * 기대 콘텐츠 프로파일 조회 (`target_profile` · FR-RU-100 · DR-CF-002).
 *
 * 계정 설정이라 계정마다 다르다. 회원가입 트랜잭션에서 63행이 함께 만들어지고, 설정
 * 화면에서 편집한다 (FR-OP-021).
 *
 * **없으면 `null`** 이고 R10 은 그 상품을 확인 불가로 남긴다. 비슷한 조합으로 대신
 * 판정하지 않는다 — 지어낸 기준으로 「구성이 맞다」고 말하는 것이 확인 불가보다 나쁘다
 * (FR-RU-051).
 *
 * 검수 한 번에 상품 하나뿐이라 캐시를 두지 않는다.
 */
export class TargetProfileRepository implements TargetProfileLookup {
  constructor(private readonly pool: Pool) {}

  async find(accountId: number, targetKey: string, conceptKey: string): Promise<TargetProfileRow | null> {
    const { rows } = await this.pool.query<{ expected_lcls2: string[]; expects_night: boolean }>(
      `SELECT expected_lcls2, expects_night
         FROM target_profile
        WHERE account_id = $1 AND target_key = $2 AND concept_key = $3`,
      [accountId, targetKey, conceptKey],
    );
    const row = rows[0];
    if (row === undefined) return null;
    // 제약(ck_profile_lcls)이 1개 이상을 보장하지만, 빈 배열이 오면 판정할 것이 없다
    if (!Array.isArray(row.expected_lcls2) || row.expected_lcls2.length === 0) return null;
    return { expectedLcls2: row.expected_lcls2, expectsNight: row.expects_night };
  }
}
