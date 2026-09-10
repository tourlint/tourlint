import { createHttpFetch, isTimeoutError } from '../http-client';
import { LlmSchemaInvalidError, LlmUnavailableError } from './llm.errors';
import type { LlmProvider, LlmStructuredRequest, LlmStructuredResult } from './llm.types';

const BASE_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_TOKENS = 2_048;

/**
 * Anthropic Messages API 어댑터.
 *
 * **구조화 출력은 도구 호출로 강제한다.** 모델에게 스키마를 도구로 주고 그 도구만 쓰도록
 * 묶으면, "네, 알겠습니다" 같은 산문이 섞이지 않고 JSON 만 온다. 프롬프트로 부탁하는
 * 방식은 대부분 되지만 대부분으로는 파서를 못 만든다.
 *
 * **`temperature` 를 보내지 않는다** (EI-LM-002 v1.6 · 이슈 #371).
 *
 * 종전에는 `temperature: 0` 을 실었고, 받지 않는 모델이 나오면 그건 모델 선택이 잘못된
 * 것이라고 보았다. Claude 5 계열이 이 값을 폐기하면서 그 전제가 깨졌다 — 신형 모델을
 * 쓰려면 보내지 않아야 한다.
 *
 * **결정론은 이 값이 지키던 것이 아니다.** `normalize-fallback` 이 적어 둔 대로
 * `temperature 0` 도 매번 같은 답을 보장하지 않으며, NF-MT-001 은 `llm_parse_cache` 가
 * 조각 단위로 답을 붙잡아 지킨다. 정답셋 13조각으로 재 봤을 때 이 값 없이도 지어내는
 * 일은 없었고, 분량 강제(`MAX_FIXED_CLOSED`)도 그대로 남아 있다.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(apiKey: string, options: { fetchImpl?: typeof globalThis.fetch } = {}) {
    if (apiKey.trim() === '') throw new Error('LLM 인증키가 비어 있습니다');
    this.apiKey = apiKey;
    this.fetchImpl = options.fetchImpl ?? createHttpFetch();
  }

  async structured(req: LlmStructuredRequest, model: string): Promise<LlmStructuredResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(BASE_URL, {
        method: 'POST',
        headers: {
          // 인증키는 헤더에만 실린다. URL 에도 로그에도 담지 않는다
          'x-api-key': this.apiKey,
          'anthropic-version': API_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          system: req.system,
          tools: [{ name: req.schemaName, description: '해석 결과를 이 모양으로 채운다', input_schema: req.schema }],
          tool_choice: { type: 'tool', name: req.schemaName },
          messages: [{ role: 'user', content: req.input }],
        }),
      });
    } catch (e) {
      // 메시지에 본문이나 키가 섞이지 않게 이름만 옮긴다
      throw new LlmUnavailableError(isTimeoutError(e) ? 'TIMEOUT' : (e as Error).name);
    }

    if (!response.ok) {
      /*
       * 본문을 읽지 않는다. 오류 본문에는 우리가 보낸 프롬프트가 되돌아오고, 거기엔
       * 공사 원문 조각이 들어 있다 (DB 명세서 6-4 누출 경로 ①).
       * 4xx 는 재시도해도 같다 — 429 만 예외다.
       */
      const retryable = response.status === 429 || response.status >= 500;
      throw new LlmUnavailableError(`HTTP ${response.status}`, retryable);
    }

    const body: unknown = await response.json();
    return { value: readToolInput(body, req.schemaName), model: readModel(body, model) };
  }
}

/** 도구 호출 블록에서 입력만 꺼낸다. 산문 블록은 버린다 */
function readToolInput(body: unknown, schemaName: string): unknown {
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new LlmSchemaInvalidError('content 가 배열이 아닙니다');

  for (const block of content) {
    const b = block as { type?: unknown; name?: unknown; input?: unknown };
    if (b.type === 'tool_use' && b.name === schemaName) return b.input;
  }

  /*
   * 도구를 강제했는데도 안 썼다면 모델이 거절했거나(안전 필터) 입력이 도구와 안 맞은 것이다.
   * 어느 쪽이든 우리가 쓸 값이 없다. 산문을 파싱해 건져내려 하지 않는다 — 그렇게 건진 값은
   * 스키마를 통과한 값이 아니다.
   */
  throw new LlmSchemaInvalidError('도구 호출 블록이 없습니다');
}

function readModel(body: unknown, fallback: string): string {
  const m = (body as { model?: unknown }).model;
  return typeof m === 'string' ? m : fallback;
}
