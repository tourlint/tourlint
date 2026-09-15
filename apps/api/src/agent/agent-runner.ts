import { Logger } from '@nestjs/common';
import { BudgetBlockedError } from '../external/budget-guard';
import {
  isLlmError,
  type AgentPurpose,
  type JsonSchema,
  type LlmAssistantBlock,
  type LlmClient,
  type LlmToolResult,
  type LlmToolSpec,
  type LlmTurn,
} from '../external/llm';
import { AgentEvidence } from './agent-evidence';

/**
 * AI 에이전트 공통 틀 — 도구 호출을 주고받는 반복 (FR-AG-001 ~ 005 · EI-LM-007 ~ 010).
 *
 * 모델이 도구를 부르면 서버가 실행해 결과를 돌려주고, 모델이 `submit_result` 로 답을 내면 끝난다.
 * 에이전트마다 **읽기 도구만** 넘긴다 — 상품 · 항목 · 판정을 바꾸는 메서드를 도구로 넘기지 않는다.
 *
 * ## 멈추는 네 가지
 *
 * 도구 호출 상한 · 시간 상한(30초) · 도구의 예산 소진 · LLM 실패. 앞의 셋은 더 조회하지 않고
 * 지금까지의 결과로 답을 달라고 한 번 청한다 — 끝난 항목이라도 돌려주기 위해서다(EX-AG-002).
 * 어떤 경우든 **거절하지 않는다.** 러너는 멈춘 이유를 돌려주고, 에이전트가 끝난 항목만 싣고
 * `incomplete` 를 채운다(EI-LM-010). 실행 전 거절(429)은 `AgentLock` 과 예산 게이트가 한다.
 *
 * ## 남기지 않는 것
 *
 * 지시문 · 입력 · 모델 문장 · 도구 결과는 저장하지 않고 로그에도 남기지 않는다. 로그 한 줄에는
 * 에이전트 이름 · 도구 호출 수 · 걸린 시간 · 결과 · 버린 건수만 있다(FR-AG-004 · EI-LM-009).
 */

/** 에이전트 한 번의 시간 상한 (EI-LM-007) */
export const AGENT_TIMEOUT_MS = 30_000;
/** 마지막 답을 받을 몫. 상한까지 이만큼 남으면 더 조회하지 않고 답을 청한다 */
export const AGENT_FINALIZE_RESERVE_MS = 8_000;
/** 끝낼 때 부르는 도구 */
export const SUBMIT_TOOL = 'submit_result';

const FINALIZE_NOTE =
  '더 조회할 수 없다. 지금까지 도구로 확인한 것만으로 submit_result 를 불러 답하라. 확인하지 못한 항목은 넣지 않는다.';
const SUBMIT_NUDGE = '답은 submit_result 도구로만 낸다. 지금까지 도구로 확인한 것만으로 submit_result 를 불러라.';

export interface AgentTool {
  readonly spec: LlmToolSpec;
  /**
   * 읽기만 한다 (FR-AG-001). 모델에게 줄 결과를 문자열로 돌려주고, 결과 안의 식별자 · 전화번호는
   * `evidence` 에 적는다. 공사 호출이 예산에 막히면 `BudgetBlockedError` 를 그대로 던진다.
   */
  run(input: unknown, evidence: AgentEvidence): Promise<string>;
}

export interface AgentRunOptions {
  readonly purpose: AgentPurpose;
  /** **계정 정보 · 인증키 · 다른 계정 데이터를 넣지 않는다** (EI-LM-009) */
  readonly system: string;
  readonly input: string;
  readonly tools: readonly AgentTool[];
  /** `submit_result` 입력의 모양 — 에이전트의 최종 답 */
  readonly resultSchema: JsonSchema;
  /** 이 실행에서 도구를 실행할 수 있는 총 횟수 (예: 줄마다 3회 × 줄 수) */
  readonly maxToolCalls: number;
  readonly timeoutMs?: number;
}

/** 끝까지 못 간 이유 */
export type AgentStop = 'TOOL_LIMIT' | 'TIME_LIMIT' | 'BUDGET' | 'LLM_FAILED' | 'NO_RESULT';

export interface AgentRunResult {
  readonly purpose: AgentPurpose;
  /** `submit_result` 입력. **검증 전 값이다** — 에이전트가 모양을 읽고 `evidence` 로 거른다 */
  readonly result: unknown;
  readonly evidence: AgentEvidence;
  readonly toolCalls: number;
  /** 정상 종료면 null. 답을 받았어도 도중에 멈췄으면 그 이유가 남는다 — 빠진 항목이 있을 수 있다 */
  readonly stopped: AgentStop | null;
  readonly elapsedMs: number;
}

/** 멈춘 이유 → `incomplete.reasonCode`. 예산이면 예산, 나머지는 LLM 을 못 쓴 것이다 (EI-LM-010) */
export function incompleteReason(stopped: AgentStop): 'BUDGET_EXHAUSTED' | 'LLM_UNAVAILABLE' {
  return stopped === 'BUDGET' ? 'BUDGET_EXHAUSTED' : 'LLM_UNAVAILABLE';
}

export class AgentRunner {
  private readonly logger = new Logger(AgentRunner.name);

  constructor(
    private readonly llm: LlmClient,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const started = this.clock();
    const timeoutMs = options.timeoutMs ?? AGENT_TIMEOUT_MS;
    const deadline = started + timeoutMs;
    const softDeadline = deadline - Math.min(AGENT_FINALIZE_RESERVE_MS, timeoutMs / 2);

    const evidence = new AgentEvidence();
    const byName = new Map(options.tools.map((t) => [t.spec.name, t]));
    const specs: LlmToolSpec[] = [
      ...options.tools.map((t) => t.spec),
      {
        name: SUBMIT_TOOL,
        description: '조회를 마치고 최종 답을 낼 때 부른다. 도구로 확인한 값만 넣는다.',
        inputSchema: options.resultSchema,
      },
    ];
    const turns: LlmTurn[] = [{ role: 'user', text: options.input }];

    let toolCalls = 0;
    let stopped: AgentStop | null = null;
    let finalizeAsked = false;
    let nudged = false;

    const finish = (result: unknown, stop: AgentStop | null): AgentRunResult =>
      ({ purpose: options.purpose, result, evidence, toolCalls, stopped: stop, elapsedMs: this.clock() - started });

    for (;;) {
      const remaining = deadline - this.clock();
      if (remaining <= 0) return finish(null, stopped ?? 'TIME_LIMIT');

      let blocks: readonly LlmAssistantBlock[];
      try {
        ({ blocks } = await this.llm.toolTurn({
          purpose: options.purpose,
          system: options.system,
          turns,
          tools: specs,
          signal: AbortSignal.timeout(remaining),
        }));
      } catch (e) {
        if (!isLlmError(e)) throw e;
        return finish(null, stopped ?? (e.message.includes('TIMEOUT') ? 'TIME_LIMIT' : 'LLM_FAILED'));
      }
      turns.push({ role: 'assistant', blocks });

      const submit = blocks.find((b) => b.type === 'tool_use' && b.name === SUBMIT_TOOL);
      if (submit !== undefined && submit.type === 'tool_use') return finish(submit.input, stopped);

      const uses = blocks.filter((b): b is Extract<LlmAssistantBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      if (uses.length === 0) {
        // 산문으로 끝냈다. 한 번만 답 도구로 내라고 청한다
        if (nudged || finalizeAsked) return finish(null, stopped ?? 'NO_RESULT');
        nudged = true;
        turns.push({ role: 'user', text: SUBMIT_NUDGE });
        continue;
      }
      // 답을 청한 뒤에도 조회만 하면 더 기다리지 않는다
      if (finalizeAsked) return finish(null, stopped ?? 'NO_RESULT');

      const results: LlmToolResult[] = [];
      for (const use of uses) {
        if (stopped === null && toolCalls >= options.maxToolCalls) stopped = 'TOOL_LIMIT';
        if (stopped === null && this.clock() >= softDeadline) stopped = 'TIME_LIMIT';
        if (stopped !== null) {
          results.push(errorResult(use.id, FINALIZE_NOTE));
          continue;
        }
        const tool = byName.get(use.name);
        if (tool === undefined) {
          results.push(errorResult(use.id, `없는 도구다: ${use.name}`));
          continue;
        }
        toolCalls += 1;
        try {
          results.push({ toolUseId: use.id, content: await tool.run(use.input, evidence), isError: false });
        } catch (e) {
          if (e instanceof BudgetBlockedError) {
            stopped = 'BUDGET';
            results.push(errorResult(use.id, '오늘 조회 예산을 다 써서 더 조회할 수 없다.'));
            continue;
          }
          // 원인 메시지는 싣지 않는다 — 공사 응답 조각이 섞일 수 있다(DB 명세서 6-4)
          results.push(errorResult(use.id, '조회에 실패했다. 다른 방법으로 찾거나 이 항목은 넣지 않는다.'));
        }
      }

      if (stopped !== null) finalizeAsked = true;
      turns.push({ role: 'tool_results', results, ...(stopped !== null ? { note: FINALIZE_NOTE } : {}) });
    }
  }

  /**
   * 실행 한 줄 로그 (FR-AG-004 · EX-AG-003). 에이전트 이름 · 도구 호출 수 · 걸린 시간 · 결과 ·
   * 버린 건수만 적는다 — 문장 · 값은 없다.
   */
  report(run: AgentRunResult, dropped: number): void {
    this.logger.log(agentLogLine(run, dropped));
  }
}

export function agentLogLine(run: AgentRunResult, dropped: number): string {
  const outcome = run.stopped === null ? '끝남' : `멈춤 ${run.stopped}`;
  return `에이전트 ${run.purpose} · 도구 ${run.toolCalls}회 · ${run.elapsedMs}ms · ${outcome} · 버림 ${dropped}건`;
}

function errorResult(toolUseId: string, content: string): LlmToolResult {
  return { toolUseId, content, isError: true };
}
