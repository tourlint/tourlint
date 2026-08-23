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
  it('temperature 0 과 tool_choice 를 보낸다', async () => {
    const seen: { body?: string } = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.body = init.body as string;
      return new Response(JSON.stringify(toolResponse({ weeklyClosed: ['MON'] })), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await new AnthropicProvider(SECRET, { fetchImpl }).structured(REQ, 'claude-sonnet-4-6');

    const sent = JSON.parse(seen.body ?? '{}') as Record<string, unknown>;
    expect(sent.temperature).toBe(0);
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
    const client = new LlmClient({ provider: { name: 'f', structured: async () => ({ value: {}, model: 'm' }) }, config: CONFIG });
    expect(client.modelFor('STRUCTURE')).toBe('claude-sonnet-5');
    expect(client.modelFor('NORMALIZE')).toBe('claude-sonnet-4-6');
  });

  it('모델이 안 적혀 있으면 부르지 않고 알린다', () => {
    const client = new LlmClient({
      provider: { name: 'f', structured: async () => ({ value: {}, model: 'm' }) },
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
