import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EXTERNAL_UNAVAILABLE_MESSAGE, type ExceptionReasonCode, type ExceptionUnit, kstIso } from '@tourlint/shared';
import type { Request, Response } from 'express';
import { isExternalError } from '../external/external.error';
import { RateLimitException } from './domain.exception';

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

    /*
     * 외부 서비스 장애는 우리 버그가 아니다 (EX-MS-003). 500 INTERNAL_ERROR 로 뭉개면
     * 원인이 어디인지 응답만 보고는 가릴 수 없고, 문구도 문서가 정한 것이 아니게 된다.
     *
     * **사유코드는 제공자를 특정해도 된다** — 그건 우리가 원인을 가르는 수단이다.
     * 사용자가 읽는 메시지에서만 제공자를 지운다.
     */
    const external = isExternalError(exception) ? exception : null;

    const status = external !== null
      ? HttpStatus.SERVICE_UNAVAILABLE
      : exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = exception instanceof HttpException ? exception.getResponse() : null;
    const body = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};

    const reasonCode = external?.reasonCode ?? pickReasonCode(body, status);
    const unit = typeof body.unit === 'string' ? (body.unit as ExceptionUnit) : defaultUnit(status);
    const occurredAt = kstIso(new Date());
    /*
     * 로그 한 줄에 사유 코드 · 처리 단위 · 대상 식별자 · 발생 시각을 싣는다 (EX-CM-005). 대상은 경로
     * 파라미터뿐이다 — 본문 · 쿼리 값 · 헤더 · 쿠키는 싣지 않는다(인증키 · 비밀번호 · 세션).
     */
    const context = [`unit=${unit}`, targetOf(req.params), `at=${occurredAt}`].filter((s) => s !== '').join(' ');

    /*
     * 처리되지 않은 예외만 서버 로그에 남긴다 (NF-OB-005).
     * console 대신 Nest Logger 를 쓰는 이유는 출력 대상을 한 곳에서 통제하기 위해서다 —
     * 공사 응답 본문이 예외 메시지에 실려 로그로 새는 경로를 막아야 한다 (DB 명세서 6-4 ②).
     */
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`[${traceId}] ${req.method} ${req.url} → ${reasonCode} ${context}`, exception);
    } else if (status >= HttpStatus.BAD_REQUEST) {
      /*
       * 거절도 한 줄 남긴다 (#673). 5xx 만 남기던 때는 운영에서 저장이 계속 막히는데 로그에
       * 실패한 적이 없는 것처럼 보였다.
       *
       * ⚠️ **경로 · 사유코드 · 단위 · 대상 · 시각 · traceId 까지다.** 거절 메시지에는 사용자가 친
       * 장소명이 들어 있고 그건 공사 원문일 수 있다 — 예외 객체도 메시지도 넘기지 않는다 (DB 명세서 6-4).
       */
      this.logger.warn(`[${traceId}] ${req.method} ${req.url} → ${reasonCode} (${status}) ${context}`);
    }

    // 빈도 제한은 언제 다시 되는지 알린다 (API 3-4 · EX-SY-008)
    if (exception instanceof RateLimitException && exception.retryAfterSeconds !== null) {
      res.setHeader('Retry-After', String(exception.retryAfterSeconds));
    }

    res.status(status).json({
      reasonCode,
      message: external !== null ? EXTERNAL_UNAVAILABLE_MESSAGE : pickMessage(body, status),
      unit,
      ...(Array.isArray(body.fieldErrors) && body.fieldErrors.length > 0
        ? { fieldErrors: body.fieldErrors }
        : {}),
      traceId,
      occurredAt,
    });
  }
}

/**
 * 로그의 대상 식별자 — 경로 파라미터(productId · runId · itemId …)를 `이름=값` 으로 (EX-CM-005).
 *
 * 식별자 모양(영숫자 · `-` · `_`, 64자까지)이 아닌 값은 뺀다. 경로에 글자를 받는 라우트가 생겨도
 * 사용자가 친 말이 로그로 새지 않게 한다. 404(없는 경로)처럼 파라미터가 없으면 빈 문자열이다.
 */
export function targetOf(params: Readonly<Record<string, unknown>> | undefined): string {
  return Object.entries(params ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && /^[\w-]{1,64}$/.test(entry[1]))
    .map(([name, value]) => `${name}=${value}`)
    .join(' ');
}

/** 형식이 틀린 입력 — 무엇이 틀렸는지 우리 문구가 없을 때 쓴다 */
export const INPUT_INVALID_MESSAGE = '보낸 값의 형식이 올바르지 않습니다. 요청 본문과 파라미터를 확인해 주세요.';

/**
 * 올린 파일이 업로드 안전망(20MB)을 넘었다. multer 가 413 과 영어 문구(`File too large`)로 던진다 —
 * 5MB 상한 안내와 같은 말로 바꾼다 (EX-IN-003 · NF-SC-006).
 */
export const PAYLOAD_TOO_LARGE_MESSAGE = '올린 파일이 너무 큽니다. 5MB 이하로 줄여 주세요.';

function pickReasonCode(body: Record<string, unknown>, status: number): ExceptionReasonCode {
  if (typeof body.reasonCode === 'string') return body.reasonCode as ExceptionReasonCode;
  /*
   * 사유코드 없이 던진 입력 오류(`BadRequestException`)와 깨진 JSON 본문이다. 서버 오류가
   * 아니다 — `INTERNAL_ERROR` 로 적으면 원인이 우리 쪽인지 보낸 쪽인지 가릴 수 없다
   * (EX-CM-021 · #612).
   */
  if (status === HttpStatus.BAD_REQUEST) return 'INPUT_INVALID';
  if (status === HttpStatus.PAYLOAD_TOO_LARGE) return 'UPLOAD_LIMIT_EXCEEDED';
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
function pickMessage(body: Record<string, unknown>, status: number): string {
  const message = typeof body.message === 'string' ? body.message : '';
  /*
   * 입력 오류인데 한국어가 아니면 우리가 쓴 문구가 아니다. JSON 파서가 만든 영어 문구
   * ("Expected double-quoted property name in JSON at position 27")가 그대로 나갔다 (#612).
   */
  if (status === HttpStatus.BAD_REQUEST && !/[가-힣]/.test(message)) return INPUT_INVALID_MESSAGE;
  if (status === HttpStatus.PAYLOAD_TOO_LARGE && !/[가-힣]/.test(message)) return PAYLOAD_TOO_LARGE_MESSAGE;
  return message !== '' ? message : '요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.';
}

function defaultUnit(status: number): ExceptionUnit {
  return status >= HttpStatus.INTERNAL_SERVER_ERROR ? 'REQUEST' : 'REQUEST';
}
