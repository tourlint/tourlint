import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(AllExceptionsFilter.name);

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

    // 처리되지 않은 예외만 서버 로그에 남긴다 (NF-OB-005).
    // console 대신 Nest Logger 를 쓰는 이유는 출력 대상을 한 곳에서 통제하기 위해서다 —
    // 공사 응답 본문이 예외 메시지에 실려 로그로 새는 경로를 막아야 한다 (DB 명세서 6-4 누출 경로 ②).
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`[${traceId}] ${req.method} ${req.url} → ${errorCode}`, exception);
    }

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
