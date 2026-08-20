import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';

/**
 * 공통 예외 필터 (D0 확정안 ⑤)
 * - 에러 응답은 이 한 곳에서만 생성한다. 핸들러마다 수제작 금지
 * - traceId 포함 (시연·심사 중 문제 추적용)
 * - 스택 트레이스·쿼리문·내부 경로 미노출 (NF-SC-009 · EX-CM-006)
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const traceId = randomUUID();

    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = exception instanceof HttpException ? exception.getResponse() : null;
    const errorCode =
      typeof payload === 'object' && payload && 'errorCode' in payload
        ? (payload as Record<string, unknown>).errorCode
        : status === 404 ? 'NOT_FOUND'
        : status === 401 ? 'NOT_AUTHENTICATED'
        : status === 403 ? 'FORBIDDEN_ACTION'
        : 'INTERNAL_ERROR';

    if (status >= 500) console.error(`[${traceId}] ${req.method} ${req.url}`, exception);

    res.status(status).json({
      errorCode,
      message:
        typeof payload === 'object' && payload && 'message' in payload
          ? (payload as Record<string, unknown>).message
          : '요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.',
      traceId,
      path: req.url,
      timestamp: new Date().toISOString(),
    });
  }
}
