import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ExceptionReasonCode, ExceptionUnit } from '@tourlint/shared';
import type { Request, Response } from 'express';

/**
 * 공통 예외 필터 — 오류 응답은 **이 한 곳에서만** 만든다 (API 설계 3-2).
 *
 * 핸들러마다 수제작하면 형식이 갈라지고, 갈라지면 화면이 어떤 필드를 믿어야 할지 모른다.
 *
 * ⚠️ **스택 트레이스 · 쿼리문 · 내부 경로 · 인증키를 응답에 담지 않는다**
 *    (NF-SC-009 · EX-CM-006 · PM-SC-003).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const traceId = randomUUID().replace(/-/g, '').slice(0, 16);

    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = exception instanceof HttpException ? exception.getResponse() : null;
    const body = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};

    const reasonCode = pickReasonCode(body, status);
    const unit = typeof body.unit === 'string' ? (body.unit as ExceptionUnit) : defaultUnit(status);

    /*
     * 처리되지 않은 예외만 서버 로그에 남긴다 (NF-OB-005).
     * console 대신 Nest Logger 를 쓰는 이유는 출력 대상을 한 곳에서 통제하기 위해서다 —
     * 공사 응답 본문이 예외 메시지에 실려 로그로 새는 경로를 막아야 한다 (DB 명세서 6-4 ②).
     */
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`[${traceId}] ${req.method} ${req.url} → ${reasonCode}`, exception);
    }

    res.status(status).json({
      reasonCode,
      message: pickMessage(body),
      unit,
      ...(Array.isArray(body.fieldErrors) && body.fieldErrors.length > 0
        ? { fieldErrors: body.fieldErrors }
        : {}),
      traceId,
      occurredAt: new Date().toISOString(),
    });
  }
}

function pickReasonCode(body: Record<string, unknown>, status: number): ExceptionReasonCode {
  if (typeof body.reasonCode === 'string') return body.reasonCode as ExceptionReasonCode;
  if (status === HttpStatus.NOT_FOUND) return 'NOT_FOUND';
  if (status === HttpStatus.UNAUTHORIZED) return 'NOT_AUTHENTICATED';
  if (status === HttpStatus.FORBIDDEN) return 'FORBIDDEN_ACTION';
  return 'INTERNAL_ERROR';
}

/**
 * 사용자 표시 문구.
 *
 * Nest 가 기본으로 만드는 문구는 영어이고 내부 사정을 드러낼 수 있어 그대로 쓰지 않는다.
 * 배열로 오는 검증 메시지도 그대로 노출하지 않는다.
 */
function pickMessage(body: Record<string, unknown>): string {
  return typeof body.message === 'string' && body.message !== ''
    ? body.message
    : '요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.';
}

function defaultUnit(status: number): ExceptionUnit {
  return status >= HttpStatus.INTERNAL_SERVER_ERROR ? 'REQUEST' : 'REQUEST';
}
