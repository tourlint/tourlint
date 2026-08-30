import type { Pool } from 'pg';
import type { LlmPurpose } from '../external/llm';

/**
 * LLM 해석 결과 캐시 (`llm_parse_cache` · EI-LM-005 · NF-MT-001).
 *
 * ## 왜 캐시가 폴백보다 먼저인가
 *
 * 러너는 매 검수마다 `parseOperatingInfo` 를 새로 돈다. 거기서 LLM 을 직접 부르면
 * **같은 상품을 세 번 검수했을 때 `message` 까지 같아야 한다는 NF-MT-001 이 흔들린다** —
 * `temperature 0` 도 매번 같은 답을 보장하지 않는다.
 *
 * 조각 단위로 답을 붙잡아 두면 두 번째 검수부터는 LLM 을 부르지 않고 같은 답을 쓴다.
 *
 * ## 원문을 담지 않는다
 *
 * 키는 `sha256(purpose + model + fragment)` 이고 값은 해석 **결과**다. 조각 자체는
 * 어디에도 남지 않는다 (DR-PR-001 · DB 명세서 6-4).
 *
 * ## 실패를 캐시하지 않는다
 *
 * LLM 이 실패하면 아무것도 넣지 않는다. 넣으면 일시적 장애가 그 조각을 영영 해석 불가로
 * 굳힌다 — 다음 검수에서 다시 시도할 수 있어야 한다.
 */

export interface CachedParse {
  readonly result: unknown;
  readonly model: string;
}

export class LlmParseCacheRepository {
  constructor(private readonly pool: Pool) {}

  /** 조각 해시로 찾는다. 없으면 `null` — 그때만 LLM 을 부른다 */
  async find(fragmentHash: string): Promise<CachedParse | null> {
    const { rows } = await this.pool.query<{ result_json: unknown; model: string }>(
      'SELECT result_json, model FROM llm_parse_cache WHERE fragment_hash = $1',
      [fragmentHash],
    );
    const row = rows[0];
    return row === undefined ? null : { result: row.result_json, model: row.model };
  }

  /** 여러 해시를 한 번에. 콘텐츠 하나에 조각이 여럿일 수 있다 */
  async findMany(hashes: readonly string[]): Promise<ReadonlyMap<string, CachedParse>> {
    if (hashes.length === 0) return new Map();
    const { rows } = await this.pool.query<{
      fragment_hash: string; result_json: unknown; model: string;
    }>(
      'SELECT fragment_hash, result_json, model FROM llm_parse_cache WHERE fragment_hash = ANY($1::text[])',
      [[...hashes]],
    );
    return new Map(rows.map((r) => [r.fragment_hash, { result: r.result_json, model: r.model }]));
  }

  /**
   * 넣는다. **이미 있으면 덮지 않는다** — 같은 키에는 같은 답이어야 하고, 덮으면
   * 그 순간 이전 검수와 결과가 갈린다 (NF-MT-001).
   */
  async put(
    fragmentHash: string,
    purpose: LlmPurpose,
    model: string,
    result: unknown,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO llm_parse_cache (fragment_hash, purpose, model, result_json)
       VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (fragment_hash) DO NOTHING`,
      [fragmentHash, purpose, model, JSON.stringify(result)],
    );
  }
}
