import type { ExceptionReasonCode, KtoOperation } from '@tourlint/shared';

/**
 * 공사 OpenAPI 호출 실패.
 *
 * 모든 실패는 예외 사유코드 하나로 확정되고, **재시도해도 되는지**를 스스로 안다.
 * 인증 오류·쿼터 초과를 재시도하면 남은 예산만 더 태운다 (EI-CM-005).
 *
 * ⚠️ 어떤 하위 클래스도 **요청 URL·응답 본문을 메시지에 담지 않는다.**
 *    URL 에는 인증키가, 본문에는 공사 원문이 들어 있다 (EI-CM-002 · NF-SC-009 · DR 저장 경계).
 */
export abstract class KtoError extends Error {
  abstract readonly reasonCode: ExceptionReasonCode;
  abstract readonly retryable: boolean;

  protected constructor(
    readonly operation: KtoOperation,
    message: string,
  ) {
    super(`[${operation}] ${message}`);
    this.name = new.target.name;
  }
}

/** 인증키가 없거나·만료·미등록 IP. 재시도해도 같다. 관리자 알림 대상 (EI-KT-003) */
export class KtoAuthError extends KtoError {
  readonly reasonCode = 'KTO_AUTH_ERROR' as const;
  readonly retryable = false;
  constructor(operation: KtoOperation, readonly providerCode: string | null, detail: string) {
    super(operation, `공사 인증 오류 (${providerCode ?? '코드없음'}): ${detail}`);
  }
}

/** 일일 호출 한도 초과. 예산 관리자에게 통지한다 (EI-KT-003 · FR-OP-004) */
export class KtoQuotaExceededError extends KtoError {
  readonly reasonCode = 'KTO_QUOTA_EXCEEDED' as const;
  readonly retryable = false;
  constructor(operation: KtoOperation, readonly providerCode: string | null, detail: string) {
    super(operation, `공사 호출 한도 초과 (${providerCode ?? '코드없음'}): ${detail}`);
  }
}

/**
 * 그 밖의 호출 실패 — 네트워크·5xx·JSON 파싱 실패·`resultCode` 이상.
 *
 * JSON 파싱 실패를 **서버 오류로 오인하지 않는다** (EI-KT-002). 공사 쪽 응답 문제이므로
 * 최대 2회 재시도한 뒤 콘텐츠 단위 확인 불가로 확정한다.
 */
export class KtoFetchError extends KtoError {
  readonly reasonCode = 'KTO_FETCH_FAILED' as const;
  // 리터럴 `true` 로 좁히면 하위 클래스가 뒤집을 수 없다 (FixtureMissingError)
  readonly retryable: boolean = true;
  constructor(
    operation: KtoOperation,
    detail: string,
    readonly httpStatus: number | null = null,
    readonly resultCode: string | null = null,
  ) {
    super(operation, detail);
  }
}

/**
 * 픽스처 리플레이에 그 콘텐츠가 없다 (`KTO_MODE=fixture`).
 *
 * **재시도하지 않는다.** 없는 스냅샷은 다시 불러도 없다. 재시도하면 개발 중 호출 로그가
 * 3배로 부풀어 예산 집계와 호출 수 검증이 실제와 어긋난다.
 */
export class FixtureMissingError extends KtoFetchError {
  override readonly retryable = false;
}

/** 연결 3초 · 응답 10초 초과 (EI-CM-004). 호출 로그에 `TIMEOUT` 으로 남는다 */
export class KtoTimeoutError extends KtoError {
  readonly reasonCode = 'KTO_FETCH_FAILED' as const;
  readonly retryable = true;
  constructor(operation: KtoOperation, readonly timeoutMs: number) {
    super(operation, `응답 시간 초과 (${timeoutMs}ms)`);
  }
}

/** 상세 조회가 0건을 돌려줬다. 콘텐츠가 삭제됐거나 애초에 없는 id 다 */
export class ContentNotFoundError extends KtoError {
  readonly reasonCode = 'CONTENT_NOT_FOUND' as const;
  readonly retryable = false;
  constructor(operation: KtoOperation, readonly contentId: string) {
    super(operation, `콘텐츠를 찾을 수 없다: contentId=${contentId}`);
  }
}

/** 호출 결과가 `KtoError` 인지 — `instanceof` 를 한 곳에 모아둔다 */
export function isKtoError(e: unknown): e is KtoError {
  return e instanceof KtoError;
}
