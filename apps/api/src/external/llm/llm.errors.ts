import type { ExceptionReasonCode } from '@tourlint/shared';

/**
 * LLM 호출 실패. **인증키를 절대 메시지에 담지 않는다** (EI-CM-002 · NF-SC-009).
 *
 * 응답 본문도 담지 않는다. 본문에는 공사 원문 조각이 되돌아오고, 오류 로그는 저장 경계
 * 바깥이다 (DB 명세서 6-4 누출 경로 ①).
 */
export abstract class LlmError extends Error {
  abstract readonly reasonCode: ExceptionReasonCode;
  abstract readonly retryable: boolean;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 호출 자체가 안 됐다 — 네트워크 · 타임아웃 · 5xx · 키 문제 */
export class LlmUnavailableError extends LlmError {
  readonly reasonCode = 'LLM_UNAVAILABLE' as const;
  constructor(reason: string, readonly retryable: boolean = true) {
    super(`LLM 호출 실패: ${reason}`);
  }
}

/** 응답은 왔는데 우리가 정한 스키마와 다르다. 재시도해도 같은 모델은 같은 모양을 낸다 */
export class LlmSchemaInvalidError extends LlmError {
  readonly reasonCode = 'PARSE_SCHEMA_INVALID' as const;
  readonly retryable = false;
  constructor(detail: string) {
    super(`LLM 응답이 스키마와 다릅니다: ${detail}`);
  }
}

/** 설정이 없거나 잘못됐다. 기동 시점에 잡는다 */
export class LlmNotConfiguredError extends LlmError {
  readonly reasonCode = 'LLM_UNAVAILABLE' as const;
  readonly retryable = false;
}
