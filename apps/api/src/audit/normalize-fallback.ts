import {
  FALLBACK_SCHEMA, FALLBACK_SCHEMA_NAME, mergeFallback, parseFallbackResult,
} from '../engine/normalize/fallback';
import type { NormalizedOperatingInfo } from '../engine/normalize/types';
import { fragmentKey, isLlmError, type LlmClient } from '../external/llm';
import type { LlmParseCacheRepository } from '../persistence/llm-parse-cache.repository';

/**
 * 정규화 폴백 (F03 · FR-AU-010 · EI-LM-005 · NF-MT-001).
 *
 * 사전 파서가 못 읽은 조각을 **캐시에서 먼저 찾고, 없을 때만 LLM 에 넘긴다.**
 *
 * ## 캐시가 먼저인 이유
 *
 * 러너는 매 검수마다 파서를 새로 돈다. 거기서 LLM 을 바로 부르면 같은 상품을 세 번
 * 검수했을 때 결과가 갈릴 수 있다 (NF-MT-001) — `temperature 0` 도 매번 같은 답을
 * 보장하지 않는다. 조각 단위로 답을 붙잡아 두면 두 번째 검수부터 같은 답이 나온다.
 *
 * ## 실패하면 조각을 그대로 둔다
 *
 * LLM 이 없거나 실패하면 그 조각은 미해석으로 남고 **검수는 계속된다** (FR-AU-010).
 * 실패를 캐시하지 않는다 — 일시적 장애가 그 조각을 영영 해석 불가로 굳히면 안 된다.
 *
 * ⚠️ **그래서 첫 검수와 다음 검수가 갈릴 수 있다.** LLM 이 죽어 있던 검수는 조각을
 *    확인 불가로 남기고, 살아난 뒤의 검수는 그것을 읽는다. 이건 「관측한 것이 달라졌다」
 *    이지 예측이 흔들린 것이 아니다 — 공사가 죽어서 확인 불가가 났던 것과 같은 종류다.
 *    캐시가 채워진 뒤로는 NF-MT-001 이 성립한다.
 *
 * ## 한 조각도 안 부를 수 있다
 *
 * 사전 파서 커버리지가 휴무 95.8% · 운영 91.7% 라 대부분의 콘텐츠는 미해석 조각이 없다.
 * 폴백은 나머지 몫이고, 조각이 없으면 이 함수는 아무것도 하지 않는다.
 */

/** 콘텐츠 하나에서 LLM 에 넘기는 조각 수 상한. 넘치면 앞에서부터만 본다 */
export const MAX_FRAGMENTS_PER_CONTENT = 3;

const SYSTEM = [
  '너는 한국 관광지의 운영정보 원문 조각 하나를 구조화한다.',
  '조각에 명시된 것만 답한다. 추론하거나 일반적인 관행을 채워 넣지 않는다.',
  '읽을 수 없으면 빈 객체를 답한다.',
  '휴무 요일은 MON~SUN, 고정 휴무일은 MM-DD, 시각은 HH:MM 24시간제로 적는다.',
  '"공휴일 다음날" 처럼 조건이 붙은 규칙이면 conditional 을 true 로 둔다.',
].join('\n');

export interface FallbackOptions {
  readonly llm: LlmClient | null;
  readonly cache: LlmParseCacheRepository;
}

/**
 * 미해석 조각을 해석해 합친 정규화 결과를 돌려준다.
 *
 * 원본을 바꾸지 않는다. 아무것도 못 해석하면 받은 것을 그대로 돌려준다.
 */
export async function applyNormalizeFallback(
  normalized: NormalizedOperatingInfo,
  options: FallbackOptions,
): Promise<NormalizedOperatingInfo> {
  const targets = normalized.unparsed.slice(0, MAX_FRAGMENTS_PER_CONTENT);
  if (targets.length === 0 || options.llm === null) return normalized;

  let model: string;
  try {
    model = options.llm.modelFor('NORMALIZE');
  } catch {
    // 모델이 설정되지 않았으면 폴백이 없는 것과 같다. 검수는 계속된다
    return normalized;
  }

  const keys = new Map(targets.map((f) => [f, fragmentKey('NORMALIZE', model, f.fragment)]));
  const cached = await options.cache.findMany([...keys.values()]);

  let out = normalized;
  for (const fragment of targets) {
    const key = keys.get(fragment) as string;
    const hit = cached.get(key);

    if (hit !== undefined) {
      const parsed = parseFallbackResult(hit.result);
      // 캐시에 든 값이 지금 스키마를 못 지나면 무시한다. 지우지는 않는다
      if (parsed !== null) out = mergeFallback(out, fragment, parsed);
      continue;
    }

    const fresh = await callOnce(options.llm, fragment.fragment);
    if (fresh === null) continue;

    const parsed = parseFallbackResult(fresh.value);
    if (parsed === null) continue;

    // 검증을 통과한 것만 캐시한다. 못 지나는 답을 넣으면 매번 다시 버리게 된다
    await options.cache.put(key, 'NORMALIZE', fresh.model, fresh.value);
    out = mergeFallback(out, fragment, parsed);
  }
  return out;
}

/** 한 번 부른다. 실패는 삼키고 `null` — 조각은 미해석으로 남는다 (FR-AU-010) */
async function callOnce(
  llm: LlmClient,
  fragment: string,
): Promise<{ value: unknown; model: string } | null> {
  try {
    return await llm.structured({
      purpose: 'NORMALIZE',
      system: SYSTEM,
      // 조각만 넘긴다. 계정 정보 · 타 상품 데이터를 담지 않는다 (EI-LM-004)
      input: fragment,
      schema: FALLBACK_SCHEMA,
      schemaName: FALLBACK_SCHEMA_NAME,
    });
  } catch (e) {
    if (!isLlmError(e)) throw e;
    return null;
  }
}
