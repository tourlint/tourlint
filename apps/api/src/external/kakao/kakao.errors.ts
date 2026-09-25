import type { ExceptionReasonCode } from '@tourlint/shared';

/**
 * 카카오모빌리티 호출 실패 (EI-KM-005 · 009).
 *
 * ⚠️ 어떤 하위 클래스도 **요청 URL 을 메시지에 담지 않는다.** 헤더에 인증키가 실린다
 * (EI-CM-002 · NF-SC-009 · PM-SC-003).
 */
export abstract class KakaoError extends Error {
  abstract readonly reasonCode: ExceptionReasonCode;
  abstract readonly retryable: boolean;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * 경로를 찾지 못했다. `result_code` 가 0 이 아닌 경우다.
 *
 * **HTTP 200 이어도 `result_code` 를 반드시 확인한다** (EI-KM-005). 200 만 보고 넘기면
 * 좌표 오류나 경로 없음이 "이동시간 0분" 으로 둔갑한다.
 */
export class RouteNotFoundError extends KakaoError {
  readonly reasonCode = 'ROUTE_NOT_FOUND' as const;
  readonly retryable = false;
  constructor(readonly resultCode: number, readonly resultMsg: string) {
    super(`경로를 찾지 못했다 (result_code ${resultCode}: ${resultMsg})`);
  }
}

/**
 * 제공자 장애 · 네트워크 · 인증 실패.
 *
 * **일시 장애만 다시 부른다** (EI-CM-005 · EX-EI-022) — 응답이 없거나(네트워크 · 시간 초과 ·
 * 해석 불가) 5xx · 429 일 때다. 그 밖의 4xx(인증 · 요청 오류)는 다시 불러도 같다.
 */
export class RouteProviderError extends KakaoError {
  readonly reasonCode = 'ROUTE_PROVIDER_FAILED' as const;
  constructor(detail: string, readonly httpStatus: number | null = null) {
    super(`길찾기 제공자 오류: ${detail}`);
  }

  get retryable(): boolean {
    return this.httpStatus === null || this.httpStatus >= 500 || this.httpStatus === 429;
  }
}

/** 대중교통은 아예 호출하지 않는다 (EI-KM-007 · FR-RU-086) */
export class TransitNotSupportedError extends KakaoError {
  readonly reasonCode = 'TRANSIT_NOT_SUPPORTED' as const;
  readonly retryable = false;
  constructor() {
    super('대중교통 구간은 길찾기를 호출하지 않는다');
  }
}

export function isKakaoError(e: unknown): e is KakaoError {
  return e instanceof KakaoError;
}
