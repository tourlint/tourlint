import { describe, expect, it } from 'vitest';
import { BudgetBlockedError } from '../external/budget-guard';
import { InMemoryApiCallLogger } from '../external/api-call-log';
import {
  LlmClient,
  LlmUnavailableError,
  type LlmAssistantBlock,
  type LlmProvider,
  type LlmToolTurnRequest,
  type LlmToolTurnResult,
} from '../external/llm';
import type { AgentEvidence } from './agent-evidence';
import {
  AGENT_TIMEOUT_MS, AgentRunner, SUBMIT_TOOL, agentLogLine, incompleteReason, type AgentTool,
} from './agent-runner';

/**
 * 고정 응답 LLM — 정해 둔 턴을 차례로 돌려준다. **실제 LLM 은 부르지 않는다.**
 * 한 턴은 모델이 낸 블록 목록이거나 던질 오류다.
 */
type ScriptedTurn = readonly LlmAssistantBlock[] | Error;

class ScriptedLlmProvider implements LlmProvider {
  readonly name = 'scripted';
  readonly requests: LlmToolTurnRequest[] = [];
  constructor(private readonly turns: readonly ScriptedTurn[]) {}

  async structured(): Promise<never> {
    throw new Error('구조화 호출은 에이전트가 쓰지 않는다');
  }

  async toolTurn(req: LlmToolTurnRequest): Promise<LlmToolTurnResult> {
    // 러너가 뒤에 턴을 더 붙이므로 그때의 대화를 복사해 둔다
    this.requests.push({ ...req, turns: [...req.turns] });
    const next = this.turns[this.requests.length - 1];
    if (next === undefined) throw new Error('준비한 턴이 없다');
    if (next instanceof Error) throw next;
    return { blocks: next, stopReason: 'tool_use', model: 'scripted' };
  }
}

const CONFIG = { provider: 'scripted', apiKey: 'k', modelStructure: 'm-s', modelNormalize: 'm-n', modelAgent: 'm-a' };

const use = (id: string, name: string, input: unknown): LlmAssistantBlock => ({ type: 'tool_use', id, name, input });
const submit = (input: unknown): LlmAssistantBlock => use('final', SUBMIT_TOOL, input);

/** 검색 도구 — 결과의 contentid 를 증거로 적는다 */
function searchTool(calls: unknown[] = []): AgentTool {
  return {
    spec: { name: 'search_places', description: '장소를 찾는다', inputSchema: { type: 'object', properties: { keyword: { type: 'string' } } } },
    run: async (input: unknown, evidence: AgentEvidence): Promise<string> => {
      calls.push(input);
      evidence.add('contentId', '129784');
      return JSON.stringify([{ contentid: '129784', title: '오죽헌' }]);
    },
  };
}

function detailTool(calls: unknown[] = []): AgentTool {
  return {
    spec: { name: 'place_detail', description: '분류 · 주소를 확인한다', inputSchema: { type: 'object', properties: { contentId: { type: 'string' } } } },
    run: async (input: unknown): Promise<string> => {
      calls.push(input);
      return JSON.stringify({ lclsSystm3: 'VE070100' });
    },
  };
}

const RESULT_SCHEMA = { type: 'object' as const, properties: { items: { type: 'array' } }, required: ['items'] };

function setup(turns: readonly ScriptedTurn[], options: { clock?: () => number } = {}) {
  const provider = new ScriptedLlmProvider(turns);
  const logger = new InMemoryApiCallLogger();
  const llm = new LlmClient({ provider, config: CONFIG, logger });
  return { provider, logger, runner: new AgentRunner(llm, options.clock) };
}

const base = { purpose: 'PLACE_MATCH' as const, system: '장소를 찾는다', input: '1일차 10:00 오죽헌', resultSchema: RESULT_SCHEMA };

describe('AgentRunner — 도구 호출 반복 (EI-LM-007)', () => {
  it('🔴 고정 응답으로 도구 2회 호출 → 최종 답을 돌려준다', async () => {
    const searched: unknown[] = [];
    const detailed: unknown[] = [];
    const { provider, runner } = setup([
      [use('t1', 'search_places', { keyword: '오죽헌' })],
      [{ type: 'text', text: '확인해 볼게요' }, use('t2', 'place_detail', { contentId: '129784' })],
      [submit({ items: [{ itemId: 1, contentId: '129784' }] })],
    ]);

    const run = await runner.run({ ...base, tools: [searchTool(searched), detailTool(detailed)], maxToolCalls: 6 });

    expect(run.result).toEqual({ items: [{ itemId: 1, contentId: '129784' }] });
    expect(run.stopped).toBeNull();
    expect(run.toolCalls).toBe(2);
    expect(searched).toEqual([{ keyword: '오죽헌' }]);
    expect(detailed).toEqual([{ contentId: '129784' }]);
    expect(run.evidence.has('contentId', '129784')).toBe(true);

    // 도구 결과는 같은 id 로 다음 턴에 붙는다 — 모델이 낸 블록도 그대로 되돌려 보낸다
    const second = provider.requests[1];
    expect(second?.turns.at(-2)).toEqual({ role: 'assistant', blocks: [use('t1', 'search_places', { keyword: '오죽헌' })] });
    expect(second?.turns.at(-1)).toMatchObject({ role: 'tool_results', results: [{ toolUseId: 't1', isError: false }] });
    // 답 도구는 모델에게 늘 보인다
    expect(second?.tools.map((t) => t.name)).toEqual(['search_places', 'place_detail', SUBMIT_TOOL]);
  });

  it('🔴 도구 호출 상한에 닿으면 더 조회하지 않고 답을 청한다 — 끝난 항목만 받는다', async () => {
    const searched: unknown[] = [];
    const { provider, runner } = setup([
      [use('a', 'search_places', { keyword: '오죽헌' }), use('b', 'search_places', { keyword: '경포대' })],
      [submit({ items: [{ itemId: 1 }] })],
    ]);

    const run = await runner.run({ ...base, tools: [searchTool(searched)], maxToolCalls: 1 });

    expect(searched).toEqual([{ keyword: '오죽헌' }]);
    expect(run.stopped).toBe('TOOL_LIMIT');
    expect(run.result).toEqual({ items: [{ itemId: 1 }] });
    expect(incompleteReason(run.stopped ?? 'NO_RESULT')).toBe('LLM_UNAVAILABLE');
    // 실행하지 않은 도구 호출에도 결과를 붙인다 — 빠뜨리면 대화가 이어지지 않는다
    const last = provider.requests[1]?.turns.at(-1);
    expect(last).toMatchObject({ role: 'tool_results', results: [{ toolUseId: 'a', isError: false }, { toolUseId: 'b', isError: true }] });
    expect(last).toHaveProperty('note');
  });

  it('🔴 답을 청한 뒤에도 조회만 하면 기다리지 않고 멈춘다', async () => {
    const { runner } = setup([
      [use('a', 'search_places', {}), use('b', 'search_places', {})],
      [use('c', 'search_places', {})],
    ]);
    const run = await runner.run({ ...base, tools: [searchTool()], maxToolCalls: 1 });
    expect(run.result).toBeNull();
    expect(run.stopped).toBe('TOOL_LIMIT');
  });

  it('🔴 30초가 지나면 끝난 항목 없이 멈춘다 — 거절하지 않는다', async () => {
    let now = 0;
    const { runner } = setup(
      [[use('a', 'search_places', {})], [submit({ items: [] })]],
      { clock: () => now },
    );
    const slowTool: AgentTool = { ...searchTool(), run: async () => { now += AGENT_TIMEOUT_MS + 1; return '[]'; } };

    const run = await runner.run({ ...base, tools: [slowTool], maxToolCalls: 5 });
    expect(run.result).toBeNull();
    expect(run.stopped).toBe('TIME_LIMIT');
  });

  it('🔴 시간 상한이 가까우면 더 조회하지 않고 답을 청한다', async () => {
    let now = 0;
    const searched: unknown[] = [];
    const { runner } = setup(
      [[use('a', 'search_places', { keyword: '1' })], [use('b', 'search_places', { keyword: '2' })], [submit({ items: [{ itemId: 1 }] })]],
      { clock: () => now },
    );
    const tool: AgentTool = { ...searchTool(), run: async (input) => { searched.push(input); now += 23_000; return '[]'; } };

    const run = await runner.run({ ...base, tools: [tool], maxToolCalls: 5 });
    expect(searched).toEqual([{ keyword: '1' }]);
    expect(run.stopped).toBe('TIME_LIMIT');
    expect(run.result).toEqual({ items: [{ itemId: 1 }] });
  });

  it('🔴 LLM 실패는 던지지 않고 멈춘 이유로 돌려준다 (EI-LM-010)', async () => {
    const { runner } = setup([new LlmUnavailableError('HTTP 503')]);
    const run = await runner.run({ ...base, tools: [searchTool()], maxToolCalls: 5 });
    expect(run.result).toBeNull();
    expect(run.stopped).toBe('LLM_FAILED');
  });

  it('LLM 시간 초과는 시간 상한으로 센다', async () => {
    const { runner } = setup([new LlmUnavailableError('TIMEOUT')]);
    expect((await runner.run({ ...base, tools: [], maxToolCalls: 5 })).stopped).toBe('TIME_LIMIT');
  });

  it('🔴 도구의 공사 호출이 예산에 막히면 답을 청하고 incomplete 사유는 BUDGET_EXHAUSTED 다', async () => {
    const { runner } = setup([[use('a', 'search_places', {})], [submit({ items: [] })]]);
    const blocked: AgentTool = {
      ...searchTool(),
      run: async () => {
        throw new BudgetBlockedError({ allowed: false, ratio: 1, reasonCode: 'BUDGET_EXHAUSTED', warn: true, remaining: 0 });
      },
    };
    const run = await runner.run({ ...base, tools: [blocked], maxToolCalls: 5 });
    expect(run.stopped).toBe('BUDGET');
    expect(run.result).toEqual({ items: [] });
    expect(incompleteReason('BUDGET')).toBe('BUDGET_EXHAUSTED');
  });

  it('🔴 도구 실패의 원인 메시지를 모델에게 싣지 않는다 — 공사 원문이 섞일 수 있다', async () => {
    const { provider, runner } = setup([[use('a', 'search_places', {})], [submit({ items: [] })]]);
    const failing: AgentTool = { ...searchTool(), run: async () => { throw new Error('강릉 오죽헌 운영시간 09:00~18:00'); } };
    await runner.run({ ...base, tools: [failing], maxToolCalls: 5 });
    expect(JSON.stringify(provider.requests[1]?.turns.at(-1))).not.toContain('오죽헌 운영시간');
  });

  it('산문으로 끝내면 한 번 답 도구를 청하고, 그래도 없으면 NO_RESULT 다', async () => {
    const { provider, runner } = setup([
      [{ type: 'text', text: '찾았습니다' }],
      [{ type: 'text', text: '오죽헌입니다' }],
    ]);
    const run = await runner.run({ ...base, tools: [searchTool()], maxToolCalls: 5 });
    expect(run.stopped).toBe('NO_RESULT');
    expect(provider.requests).toHaveLength(2);
  });

  it('없는 도구를 부르면 오류 결과로 알리고 세지 않는다', async () => {
    const { runner } = setup([[use('a', 'update_item', { itemId: 1 })], [submit({ items: [] })]]);
    const run = await runner.run({ ...base, tools: [searchTool()], maxToolCalls: 5 });
    expect(run.toolCalls).toBe(0);
    expect(run.result).toEqual({ items: [] });
  });
});

describe('남기지 않는 것 (FR-AG-004 · EI-LM-009)', () => {
  it('🔴 로그 한 줄에는 이름 · 도구 호출 수 · 걸린 시간 · 결과 · 버린 건수만 있다', async () => {
    const { runner } = setup([[use('a', 'search_places', { keyword: '오죽헌' })], [submit({ items: [{ reason: '앞 일정과 가장 가까워요' }] })]]);
    const run = await runner.run({ ...base, tools: [searchTool()], maxToolCalls: 5 });
    const line = agentLogLine(run, 1);
    expect(line).toMatch(/^에이전트 PLACE_MATCH · 도구 1회 · \d+ms · 끝남 · 버림 1건$/);
    for (const leak of ['오죽헌', '가까워요', '129784', '장소를 찾는다']) expect(line).not.toContain(leak);
  });

  it('🔴 LLM 호출 로그는 provider LLM · operation 목적만 남긴다', async () => {
    const { logger, runner } = setup([[use('a', 'search_places', { keyword: '오죽헌' })], [submit({ items: [] })]]);
    await runner.run({ ...base, tools: [searchTool()], maxToolCalls: 5 });
    expect(logger.entries.map((e) => [e.provider, e.operation, e.status])).toEqual([
      ['LLM', 'PLACE_MATCH', 'OK'],
      ['LLM', 'PLACE_MATCH', 'OK'],
    ]);
    expect(JSON.stringify(logger.entries)).not.toMatch(/오죽헌|장소를 찾는다|129784/);
  });
});
