import type { ExceptionReasonCode } from '@tourlint/shared';

/**
 * 기상청 예보 조회 실패 (EI-WX-006).
 *
 * 사유코드는 둘 다 `FORECAST_UNAVAILABLE` 이다. 화면에 보이는 결과가 같기 때문이다 —
 * 예보를 못 받았으면 그 날짜는 예보 근거로 판정하지 않는다. 나뉘는 것은 **재시도 여부**뿐이다.
 *
 * ⚠️ 어떤 하위 클래스도 **요청 URL 을 메시지에 담지 않는다.** 인증키가 쿼리에 실린다
 * (EI-CM-002 · NF-SC-009).
 */
export abstract class KmaError extends Error {
  abstract readonly reasonCode: ExceptionReasonCode;
  abstract readonly retryable: boolean;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 제공자 장애 · 네트워크 · 타임아웃 · 인증 실패. 재시도 대상이다 */
export class ForecastProviderError extends KmaError {
  readonly reasonCode = 'FORECAST_UNAVAILABLE' as const;
  readonly retryable = true;
  constructor(detail: string, readonly httpStatus: number | null = null, readonly resultCode: string | null = null) {
    super(`기상청 예보 조회 실패: ${detail}`);
  }
}

/**
 * 그 발표분이 없다. `resultCode` 03(`NO_DATA`) · 99(조회 기간 초과)가 여기로 온다.
 *
 * 재시도해도 같은 답이 온다 — 발표되지 않았거나 보존 기간을 지난 것이라 시간이 지나야
 * 달라진다. 조회 시각을 잘못 골랐다는 신호이기도 하다 (EI-WX-008).
 */
export class ForecastMissingError extends KmaError {
  readonly reasonCode = 'FORECAST_UNAVAILABLE' as const;
  readonly retryable = false;
  constructor(detail: string, readonly resultCode: string | null = null) {
    super(`기상청 예보가 없다: ${detail}`);
  }
}

export function isKmaError(e: unknown): e is KmaError {
  return e instanceof KmaError;
}
