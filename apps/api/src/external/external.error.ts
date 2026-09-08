import type { ExceptionReasonCode } from '@tourlint/shared';
import { isKakaoError } from './kakao/kakao.errors';
import { isKmaError } from './kma/kma.errors';
import { isKtoError } from './kto/kto.errors';
import { isLlmError } from './llm/llm.errors';

/**
 * 외부 어댑터가 던진 오류인가 (EX-MS-003).
 *
 * 네 어댑터가 모두 `reasonCode` 를 들고 있어서 예외 필터가 한 번에 알아본다. 어댑터가
 * 늘면 여기만 고친다 — 필터가 어댑터를 하나씩 알게 하면 그 목록이 두 곳으로 갈린다.
 */
export interface ExternalError extends Error {
  readonly reasonCode: ExceptionReasonCode;
}

export function isExternalError(e: unknown): e is ExternalError {
  return isKtoError(e) || isKakaoError(e) || isKmaError(e) || isLlmError(e);
}
