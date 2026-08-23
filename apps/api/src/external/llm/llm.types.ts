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

/** LLM 을 쓰는 세 자리 (EI-LM-001). 그 밖에는 쓰지 않는다 */
export const LLM_PURPOSE = ['STRUCTURE', 'NORMALIZE'] as const;
export type LlmPurpose = (typeof LLM_PURPOSE)[number];

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

export interface LlmProvider {
  readonly name: string;
  /** 모델을 부르고 구조화 결과를 돌려준다. 재시도는 호출자가 관리한다 */
  structured(req: LlmStructuredRequest, model: string): Promise<LlmStructuredResult>;
}
