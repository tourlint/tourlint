/**
 * 제공자에 묶이지 않는 LLM 계약 (EI-LM-006).
 *
 * 파서를 특정 모델의 응답 형식에 결합하지 않는다. 어댑터가 제공자별 모양을
 * 여기 정의한 모양으로 바꿔 놓고, 위층은 이것만 안다.
 */

/** 구조화 출력 요청. 스키마를 고정해 보내고 그 모양으로 받는다 (EI-LM-002) */
export interface LlmStructuredRequest {
  /** 용도. 모델 선택과 호출 로그에 쓴다 */
  readonly purpose: LlmPurpose;
  /** 모델에게 주는 지시. **계정 정보 · 인증키 · 타 상품 데이터를 담지 않는다** (EI-LM-004) */
  readonly system: string;
  /** 해석 대상. 원문 조각 또는 일정 텍스트로 한정한다 (EI-LM-004) */
  readonly input: string;
  /** 받고자 하는 JSON 모양 */
  readonly schema: JsonSchema;
  /** 스키마의 이름. 제공자에 따라 도구 이름 등으로 쓰인다 */
  readonly schemaName: string;
}

/**
 * LLM 을 쓰는 다섯 자리 (EI-LM-001). 그 밖에는 쓰지 않는다.
 * 일정 구조화 · 운영정보 정규화와 에이전트 셋(장소 찾기 · 확인 질문 · 오늘 할 일)이다.
 */
export const LLM_PURPOSE = ['STRUCTURE', 'NORMALIZE', 'PLACE_MATCH', 'CHECK_QUESTIONS', 'TODAY_BRIEF'] as const;
export type LlmPurpose = (typeof LLM_PURPOSE)[number];

/** 도구 호출을 주고받는 반복으로 도는 에이전트 셋 (EI-LM-007). 호출 로그 `operation` 이 이 이름이다 */
export const AGENT_PURPOSE = ['PLACE_MATCH', 'CHECK_QUESTIONS', 'TODAY_BRIEF'] as const;
export type AgentPurpose = (typeof AGENT_PURPOSE)[number];

export interface JsonSchema {
  readonly type: 'object';
  readonly properties: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

export interface LlmStructuredResult {
  /** 스키마를 통과한 객체 */
  readonly value: unknown;
  /** 실제로 응답한 모델. 설정과 다를 수 있어 그대로 남긴다 */
  readonly model: string;
}

/** 에이전트가 모델에게 보여 주는 도구 하나. 실행은 서버가 하고 모델은 이름 · 입력만 정한다 */
export interface LlmToolSpec {
  readonly name: string;
  /** 언제 부르는지까지 적는다 — 모델이 이 설명으로 도구를 고른다 */
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

/** 모델이 한 턴에 낸 블록. 산문 또는 도구 호출이다 */
export type LlmAssistantBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown };

/** 서버가 실행한 도구의 결과. 모델에게는 문자열로만 간다 */
export interface LlmToolResult {
  readonly toolUseId: string;
  readonly content: string;
  readonly isError: boolean;
}

/**
 * 도구 호출 대화의 한 턴.
 *
 * 모델이 낸 블록은 **그대로** 되돌려 보내야 한다 — 도구 호출 블록마다 같은 id 의 결과가 다음
 * 턴에 한 번에 붙어야 대화가 이어진다. `note` 는 결과 뒤에 붙이는 서버 안내다(상한에 닿음 등).
 */
export type LlmTurn =
  | { readonly role: 'user'; readonly text: string }
  | { readonly role: 'assistant'; readonly blocks: readonly LlmAssistantBlock[] }
  | { readonly role: 'tool_results'; readonly results: readonly LlmToolResult[]; readonly note?: string };

export interface LlmToolTurnRequest {
  readonly purpose: AgentPurpose;
  /** **계정 정보 · 인증키 · 다른 계정 데이터를 담지 않는다** (EI-LM-009) */
  readonly system: string;
  readonly turns: readonly LlmTurn[];
  readonly tools: readonly LlmToolSpec[];
  /** 에이전트 시간 상한(30초)에서 남은 만큼. 끊기면 시간 초과로 실패한다 */
  readonly signal?: AbortSignal;
}

export interface LlmToolTurnResult {
  readonly blocks: readonly LlmAssistantBlock[];
  /** `tool_use` · `end_turn` · `max_tokens` 등 제공자 값 그대로 */
  readonly stopReason: string | null;
  readonly model: string;
}

export interface LlmProvider {
  readonly name: string;
  /** 모델을 부르고 구조화 결과를 돌려준다. 재시도는 호출자가 관리한다 */
  structured(req: LlmStructuredRequest, model: string): Promise<LlmStructuredResult>;
  /** 도구 호출 대화의 다음 턴 하나를 받는다. 도구 실행과 반복은 에이전트 러너가 한다 */
  toolTurn(req: LlmToolTurnRequest, model: string): Promise<LlmToolTurnResult>;
}
