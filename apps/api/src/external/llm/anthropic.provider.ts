import { createHttpFetch, isTimeoutError } from '../http-client';
import { LlmSchemaInvalidError, LlmUnavailableError } from './llm.errors';
import type {
  LlmAssistantBlock, LlmProvider, LlmStructuredRequest, LlmStructuredResult, LlmToolTurnRequest,
  LlmToolTurnResult, LlmTurn,
} from './llm.types';

const BASE_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_TOKENS = 2_048;
/** 에이전트 한 턴. 곳마다 이유 · 질문을 적은 최종 답이 들어갈 만큼이다 */
const AGENT_MAX_TOKENS = 4_096;
/** 에이전트 요청 하나의 응답 타임아웃. 실행 전체 30초 상한은 러너가 따로 건다 */
const AGENT_RESPONSE_TIMEOUT_MS = 30_000;

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
  private readonly agentFetchImpl: typeof globalThis.fetch;

  constructor(
    apiKey: string,
    options: { fetchImpl?: typeof globalThis.fetch; agentFetchImpl?: typeof globalThis.fetch } = {},
  ) {
    if (apiKey.trim() === '') throw new Error('LLM 인증키가 비어 있습니다');
    this.apiKey = apiKey;
    this.fetchImpl = options.fetchImpl ?? createHttpFetch();
    this.agentFetchImpl = options.agentFetchImpl
      ?? options.fetchImpl
      ?? createHttpFetch({ responseTimeoutMs: AGENT_RESPONSE_TIMEOUT_MS });
  }

  async structured(req: LlmStructuredRequest, model: string): Promise<LlmStructuredResult> {
    const response = await this.post(this.fetchImpl, {
      model,
      max_tokens: MAX_TOKENS,
      system: req.system,
      tools: [{ name: req.schemaName, description: '해석 결과를 이 모양으로 채운다', input_schema: req.schema }],
      tool_choice: { type: 'tool', name: req.schemaName },
      messages: [{ role: 'user', content: req.input }],
    });
    const body: unknown = await response.json();
    return { value: readToolInput(body, req.schemaName), model: readModel(body, model) };
  }

  /**
   * 도구 호출 대화의 다음 턴 (EI-LM-007).
   *
   * **도구를 강제하지 않는다(`tool_choice: auto`).** 강제 호출을 400 으로 거절하는 모델이 있어
   * 강제하면 모델 교체(EI-LM-006)가 막힌다. 끝낼 때 어느 도구로 답하는지는 지시문이 정하고,
   * 답의 값은 서버가 도구 결과와 대조해 거른다 (EI-LM-008).
   */
  async toolTurn(req: LlmToolTurnRequest, model: string): Promise<LlmToolTurnResult> {
    const response = await this.post(this.agentFetchImpl, {
      model,
      max_tokens: AGENT_MAX_TOKENS,
      system: req.system,
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
      tool_choice: { type: 'auto' },
      messages: req.turns.map(toApiMessage),
    }, req.signal);
    const body: unknown = await response.json();
    const stop = (body as { stop_reason?: unknown }).stop_reason;
    return {
      blocks: readBlocks(body),
      stopReason: typeof stop === 'string' ? stop : null,
      model: readModel(body, model),
    };
  }

  private async post(
    fetchImpl: typeof globalThis.fetch,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(BASE_URL, {
        method: 'POST',
        headers: {
          // 인증키는 헤더에만 실린다. URL 에도 로그에도 담지 않는다
          'x-api-key': this.apiKey,
          'anthropic-version': API_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        ...(signal === undefined ? {} : { signal }),
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
    return response;
  }
}

/** 대화 한 턴을 Messages API 모양으로. 도구 결과는 한 사용자 메시지에 모두 담고 안내는 뒤에 붙인다 */
function toApiMessage(turn: LlmTurn): Record<string, unknown> {
  switch (turn.role) {
    case 'user':
      return { role: 'user', content: turn.text };
    case 'assistant':
      return {
        role: 'assistant',
        content: turn.blocks.map((b) => (b.type === 'text'
          ? { type: 'text', text: b.text }
          : { type: 'tool_use', id: b.id, name: b.name, input: b.input })),
      };
    case 'tool_results':
      return {
        role: 'user',
        content: [
          ...turn.results.map((r) => ({
            type: 'tool_result',
            tool_use_id: r.toolUseId,
            content: r.content,
            ...(r.isError ? { is_error: true } : {}),
          })),
          ...(turn.note === undefined ? [] : [{ type: 'text', text: turn.note }]),
        ],
      };
  }
}

/** 응답 블록 중 산문 · 도구 호출만 꺼낸다. 모르는 블록은 버린다 */
function readBlocks(body: unknown): readonly LlmAssistantBlock[] {
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new LlmSchemaInvalidError('content 가 배열이 아닙니다');
  const blocks: LlmAssistantBlock[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') blocks.push({ type: 'text', text: b.text });
    if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
      blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
    }
  }
  return blocks;
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
