import { HttpException, type HttpStatus } from '@nestjs/common';
import type { ExceptionReasonCode, ExceptionUnit } from '@tourlint/shared';

/**
 * 사유코드와 처리 단위를 함께 나르는 예외 (API 설계 3-2 · EX-CM-001 · 020).
 *
 * 모든 오류는 **처리 단위 8종 중 하나**를 갖는다. 단위가 곧 "무엇이 실패했고 무엇은
 * 살아남았는가" 를 말한다 — `CONTENT` 면 그 관광지만 확인 불가고 나머지는 판정된다.
 *
 * 사유코드를 문자열로 직접 쓰지 않는다 (EX-CM-020). `ExceptionReasonCode` 가 강제한다.
 */
export interface FieldError {
  readonly field: string;
  readonly message: string;
}

export class DomainException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly reasonCode: ExceptionReasonCode,
    /** **무엇이 · 왜 · 다음에 무엇을** 세 요소를 담는다 (EX-MS-001) */
    message: string,
    readonly unit: ExceptionUnit = 'REQUEST',
    readonly fieldErrors?: readonly FieldError[],
  ) {
    super({ reasonCode, message, unit, fieldErrors }, status);
  }
}
