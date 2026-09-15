import { describe, expect, it, vi } from 'vitest';
import { InMemoryApiCallLogger } from '../api-call-log';
import { AnthropicProvider } from './anthropic.provider';
import { LlmClient, createProvider, fragmentKey, readLlmConfig } from './llm.client';
import { LlmNotConfiguredError, LlmSchemaInvalidError, LlmUnavailableError } from './llm.errors';
import type { LlmProvider, LlmStructuredRequest } from './llm.types';

const SECRET = 'sk-ant-SUPER-SECRET-KEY';

const CONFIG = {
  provider: 'anthropic',
  apiKey: SECRET,
  modelStructure: 'claude-sonnet-5',
  modelNormalize: 'claude-sonnet-4-6',
  modelAgent: 'claude-sonnet-5',
};

const REQ: LlmStructuredRequest = {
  purpose: 'NORMALIZE',
  system: '운영정보 조각을 해석한다',
  input: '매주 월요일 휴관',
  schemaName: 'operating_info',
  schema: { type: 'object', properties: { weeklyClosed: { type: 'array' } }, required: ['weeklyClosed'] },
};

/** 응답 하나를 돌려주는 가짜 fetch */
const respond = (status: number, body: unknown): typeof globalThis.fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;

const toolResponse = (input: unknown): unknown => ({
  model: 'claude-sonnet-4-6-20260101',
  content: [{ type: 'tool_use', name: 'operating_info', input }],
});

describe('구조화 출력을 도구로 강제한다 (EI-LM-002)', () => {
  it('tool_choice 를 보내고 temperature 는 보내지 않는다', async () => {
    const seen: { body?: string } = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.body = init.body as string;
      return new Response(JSON.stringify(toolResponse({ weeklyClosed: ['MON'] })), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await new AnthropicProvider(SECRET, { fetchImpl }).structured(REQ, 'claude-sonnet-4-6');

    const sent = JSON.parse(seen.body ?? '{}') as Record<string, unknown>;
    /*
     * Claude 5 계열이 `temperature` 를 폐기해 실으면 400 이 난다 (이슈 #371). 결정론은
     * 이 값이 아니라 `llm_parse_cache` 가 지킨다 — 되살리면 신형 모델이 통째로 막힌다.
     */
    expect(sent.temperature).toBeUndefined();
    expect(sent.tool_choice).toEqual({ type: 'tool', name: 'operating_info' });
    expect(sent.model).toBe('claude-sonnet-4-6');
  });

  it('도구 호출 블록에서 값을 꺼낸다', async () => {
    const p = new AnthropicProvider(SECRET, { fetchImpl: respond(200, toolResponse({ weeklyClosed: ['MON'] })) });
    const out = await p.structured(REQ, 'claude-sonnet-4-6');
    expect(out.value).toEqual({ weeklyClosed: ['MON'] });
    expect(out.model).toBe('claude-sonnet-4-6-20260101');
  });

  it('산문만 오면 파싱해 건지지 않는다 — 그렇게 건진 값은 스키마를 통과한 값이 아니다', async () => {
    const prose = { content: [{ type: 'text', text: '{"weeklyClosed":["MON"]}' }] };
    const p = new AnthropicProvider(SECRET, { fetchImpl: respond(200, prose) });
    await expect(p.structured(REQ, 'm')).rejects.toBeInstanceOf(LlmSchemaInvalidError);
  });

  it('다른 이름의 도구를 쓰면 받지 않는다', async () => {
    const wrong = { content: [{ type: 'tool_use', name: 'something_else', input: {} }] };
    const p = new AnthropicProvider(SECRET, { fetchImpl: respond(200, wrong) });
    await expect(p.structured(REQ, 'm')).rejects.toBeInstanceOf(LlmSchemaInvalidError);
  });
});

describe('인증키와 원문이 새지 않는다 (EI-CM-002 · NF-SC-009 · DB 6-4)', () => {
  it('네트워크 오류 메시지와 스택에 키가 없다', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    const e = await new AnthropicProvider(SECRET, { fetchImpl }).structured(REQ, 'm').catch((x: unknown) => x);
    expect(JSON.stringify({ m: (e as Error).message, s: (e as Error).stack })).not.toContain('SUPER-SECRET');
  });

  it('오류 응답의 본문을 읽지 않는다 — 본문에는 우리가 보낸 원문이 되돌아온다', async () => {
    const echo = { error: { message: `요청이 거부됨: ${REQ.input}` } };
    const p = new AnthropicProvider(SECRET, { fetchImpl: respond(400, echo) });
    const e = await p.structured(REQ, 'm').catch((x: unknown) => x);
    expect((e as Error).message).toBe('LLM 호출 실패: HTTP 400');
    expect((e as Error).message).not.toContain('매주 월요일');
  });

  it('빈 키로는 만들 수 없다', () => {
    expect(() => new AnthropicProvider('   ')).toThrow(/인증키/);
  });

  it('호출 로그에 프롬프트도 응답도 남지 않는다', async () => {
    const logger = new InMemoryApiCallLogger();
    const provider: LlmProvider = {
      name: 'fake',
      structured: async () => ({ value: { weeklyClosed: ['MON'] }, model: 'm' }),
      toolTurn: async () => { throw new Error('도구 호출은 이 테스트에서 쓰지 않는다'); },
    };
    await new LlmClient({ provider, config: CONFIG, logger }).structured(REQ);

    const dumped = JSON.stringify(logger.entries);
    expect(dumped).not.toContain('매주 월요일');
    expect(dumped).not.toContain('운영정보 조각을 해석한다');
    expect(dumped).not.toContain('SUPER-SECRET');
    expect(dumped).toContain('NORMALIZE:claude-sonnet-4-6');
  });
});

describe('재시도는 1회다 (EI-LM-003)', () => {
  const failing = (error: Error, succeedOn: number): LlmProvider => {
    let n = 0;
    return {
      name: 'fake',
      structured: async () => {
        n += 1;
        if (n < succeedOn) throw error;
        return { value: { ok: true }, model: 'm' };
      },
      toolTurn: async () => { throw new Error('도구 호출은 이 테스트에서 쓰지 않는다'); },
    };
  };

  it('되돌릴 값어치가 있는 실패는 한 번 더 부른다', async () => {
    const provider = failing(new LlmUnavailableError('HTTP 503'), 2);
    const spy = vi.spyOn(provider, 'structured');
    const out = await new LlmClient({ provider, config: CONFIG }).structured(REQ);
    expect(out.value).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('두 번 실패하면 던진다 — 검수는 호출자가 이어간다', async () => {
    const provider = failing(new LlmUnavailableError('HTTP 503'), 99);
    const spy = vi.spyOn(provider, 'structured');
    await expect(new LlmClient({ provider, config: CONFIG }).structured(REQ)).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('스키마 불일치는 재시도하지 않는다 — 같은 모델에 같은 입력이면 같은 모양이 온다', async () => {
    const provider = failing(new LlmSchemaInvalidError('도구 호출 블록이 없습니다'), 99);
    const spy = vi.spyOn(provider, 'structured');
    await expect(new LlmClient({ provider, config: CONFIG }).structured(REQ)).rejects.toBeInstanceOf(
      LlmSchemaInvalidError,
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('400 은 되돌리지 않고 429 와 5xx 는 되돌린다', async () => {
    const p = (status: number): AnthropicProvider => new AnthropicProvider(SECRET, { fetchImpl: respond(status, {}) });
    const retryable = async (status: number): Promise<boolean> => {
      const e = await p(status).structured(REQ, 'm').catch((x: unknown) => x);
      return (e as LlmUnavailableError).retryable;
    };
    expect(await retryable(400)).toBe(false);
    expect(await retryable(401)).toBe(false);
    expect(await retryable(429)).toBe(true);
    expect(await retryable(503)).toBe(true);
  });
});

describe('제공자와 모델을 환경변수로 바꾼다 (EI-LM-006)', () => {
  it('키가 없으면 설정이 없는 것이다 — 던지지 않는다', () => {
    expect(readLlmConfig({})).toBeNull();
    expect(readLlmConfig({ LLM_API_KEY: '   ' })).toBeNull();
  });

  it('제공자를 안 적으면 anthropic 이다', () => {
    expect(readLlmConfig({ LLM_API_KEY: 'k' })?.provider).toBe('anthropic');
  });

  it('모르는 제공자는 조용히 넘어가지 않는다', () => {
    expect(() => createProvider({ ...CONFIG, provider: 'openai' })).toThrow(LlmNotConfiguredError);
  });

  it('용도마다 다른 모델을 쓴다 — 병목이 다르다', () => {
    const client = new LlmClient({ provider: { name: 'f', structured: async () => ({ value: {}, model: 'm' }), toolTurn: async () => { throw new Error('도구 호출은 이 테스트에서 쓰지 않는다'); } }, config: CONFIG });
    expect(client.modelFor('STRUCTURE')).toBe('claude-sonnet-5');
    expect(client.modelFor('NORMALIZE')).toBe('claude-sonnet-4-6');
    // 에이전트 셋은 한 모델을 같이 쓴다
    expect(client.modelFor('PLACE_MATCH')).toBe('claude-sonnet-5');
    expect(client.modelFor('TODAY_BRIEF')).toBe('claude-sonnet-5');
  });

  it('모델이 안 적혀 있으면 부르지 않고 알린다', () => {
    const client = new LlmClient({
      provider: { name: 'f', structured: async () => ({ value: {}, model: 'm' }), toolTurn: async () => { throw new Error('도구 호출은 이 테스트에서 쓰지 않는다'); } },
      config: { ...CONFIG, modelNormalize: '' },
    });
    expect(() => client.modelFor('NORMALIZE')).toThrow(LlmNotConfiguredError);
  });
});

describe('조각 해시 (EI-LM-005 · NF-MT-001)', () => {
  it('같은 조각은 같은 키다', () => {
    expect(fragmentKey('NORMALIZE', 'm', '매주 월요일 휴관')).toBe(fragmentKey('NORMALIZE', 'm', '매주 월요일 휴관'));
  });

  it('모델이 바뀌면 키도 바뀐다 — 모델을 바꾸면 답도 달라진다', () => {
    expect(fragmentKey('NORMALIZE', 'a', 'x')).not.toBe(fragmentKey('NORMALIZE', 'b', 'x'));
  });

  it('용도가 바뀌면 키도 바뀐다', () => {
    expect(fragmentKey('NORMALIZE', 'm', 'x')).not.toBe(fragmentKey('STRUCTURE', 'm', 'x'));
  });

  it('원문이 아니라 해시다 — 저장해도 원문이 남지 않는다', () => {
    const key = fragmentKey('NORMALIZE', 'm', '매주 월요일 휴관');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('월요일');
  });
});

describe('도구 호출 대화 (EI-LM-007)', () => {
  const TURN_REQ = {
    purpose: 'PLACE_MATCH' as const,
    system: '고르지 않은 줄의 장소를 찾는다',
    tools: [
      { name: 'search_places', description: '상품 지역에서 장소를 찾는다', inputSchema: { type: 'object' as const, properties: { keyword: { type: 'string' } } } },
      { name: 'submit_result', description: '답을 낸다', inputSchema: { type: 'object' as const, properties: {} } },
    ],
    turns: [
      { role: 'user' as const, text: '1일차 10:00 오죽헌' },
      { role: 'assistant' as const, blocks: [{ type: 'text' as const, text: '찾아볼게요' }, { type: 'tool_use' as const, id: 'toolu_1', name: 'search_places', input: { keyword: '오죽헌' } }] },
      { role: 'tool_results' as const, results: [{ toolUseId: 'toolu_1', content: '[{"contentid":"129784"}]', isError: false }], note: '더 조회할 수 없다' },
    ],
  };

  const capture = (response: unknown, status = 200) => {
    const seen: { body?: Record<string, unknown>; signal?: AbortSignal | null } = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.body = JSON.parse(init.body as string) as Record<string, unknown>;
      seen.signal = init.signal ?? null;
      return new Response(JSON.stringify(response), { status });
    }) as unknown as typeof globalThis.fetch;
    return { seen, fetchImpl };
  };

  it('🔴 도구를 강제하지 않고(tool_choice auto) 대화를 Messages API 모양으로 보낸다', async () => {
    const { seen, fetchImpl } = capture({ model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [] });
    const signal = new AbortController().signal;
    await new AnthropicProvider(SECRET, { fetchImpl }).toolTurn({ ...TURN_REQ, signal }, 'claude-sonnet-5');

    const body = seen.body ?? {};
    // 강제 호출을 400 으로 거절하는 모델이 있다 — 강제하면 모델을 바꿀 수 없다
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(body.temperature).toBeUndefined();
    expect(body.tools).toEqual([
      { name: 'search_places', description: '상품 지역에서 장소를 찾는다', input_schema: TURN_REQ.tools[0]?.inputSchema },
      { name: 'submit_result', description: '답을 낸다', input_schema: { type: 'object', properties: {} } },
    ]);
    expect(body.messages).toEqual([
      { role: 'user', content: '1일차 10:00 오죽헌' },
      { role: 'assistant', content: [
        { type: 'text', text: '찾아볼게요' },
        { type: 'tool_use', id: 'toolu_1', name: 'search_places', input: { keyword: '오죽헌' } },
      ] },
      // 도구 결과는 한 사용자 메시지에 담고, 서버 안내는 결과 뒤에 붙인다
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: '[{"contentid":"129784"}]' },
        { type: 'text', text: '더 조회할 수 없다' },
      ] },
    ]);
    expect(seen.signal).toBe(signal);
  });

  it('실패한 도구 결과는 is_error 로 표시한다', async () => {
    const { seen, fetchImpl } = capture({ content: [] });
    await new AnthropicProvider(SECRET, { fetchImpl }).toolTurn({
      ...TURN_REQ,
      turns: [{ role: 'tool_results', results: [{ toolUseId: 't', content: '조회에 실패했다', isError: true }] }],
    }, 'm');
    expect((seen.body?.messages as unknown[])[0]).toEqual({
      role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '조회에 실패했다', is_error: true }],
    });
  });

  it('응답에서 산문 · 도구 호출 블록과 stop_reason 을 읽고 모르는 블록은 버린다', async () => {
    const { fetchImpl } = capture({
      model: 'claude-sonnet-5-20260801',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '찾아볼게요' },
        { type: 'tool_use', id: 'toolu_2', name: 'search_places', input: { keyword: '경포대' } },
        { type: 'mystery', payload: 1 },
      ],
    });
    const out = await new AnthropicProvider(SECRET, { fetchImpl }).toolTurn(TURN_REQ, 'claude-sonnet-5');
    expect(out).toEqual({
      blocks: [
        { type: 'text', text: '찾아볼게요' },
        { type: 'tool_use', id: 'toolu_2', name: 'search_places', input: { keyword: '경포대' } },
      ],
      stopReason: 'tool_use',
      model: 'claude-sonnet-5-20260801',
    });
  });

  it('🔴 HTTP 오류에 본문을 싣지 않는다 — 우리가 보낸 대화가 되돌아온다', async () => {
    const fetchImpl = respond(400, { error: { message: '1일차 10:00 오죽헌 은 잘못됐습니다' } });
    const e = await new AnthropicProvider(SECRET, { fetchImpl }).toolTurn(TURN_REQ, 'm').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LlmUnavailableError);
    expect((e as Error).message).not.toContain('오죽헌');
    expect((e as Error).message).not.toContain(SECRET);
  });

  it('시간 상한으로 끊기면 TIMEOUT 이다', async () => {
    const fetchImpl = (async () => {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    }) as unknown as typeof globalThis.fetch;
    const e = await new AnthropicProvider(SECRET, { fetchImpl }).toolTurn(TURN_REQ, 'm').catch((x: unknown) => x);
    expect((e as Error).message).toContain('TIMEOUT');
  });

  it('🔴 호출 로그 operation 은 목적만이고 대화 · 도구 결과는 남지 않는다 — 재시도하지 않는다', async () => {
    const logger = new InMemoryApiCallLogger();
    let calls = 0;
    const provider: LlmProvider = {
      name: 'fake',
      structured: async () => { throw new Error('안 쓴다'); },
      toolTurn: async () => { calls += 1; throw new LlmUnavailableError('HTTP 503'); },
    };
    const client = new LlmClient({ provider, config: CONFIG, logger });
    await expect(client.toolTurn(TURN_REQ)).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(calls).toBe(1);
    expect(logger.entries.map((e) => [e.provider, e.operation, e.status])).toEqual([['LLM', 'PLACE_MATCH', 'FAIL']]);
    expect(JSON.stringify(logger.entries)).not.toMatch(/오죽헌|129784|고르지 않은 줄/);
  });
});

