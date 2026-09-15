import { HttpStatus, NotFoundException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { EXTERNAL_UNAVAILABLE_MESSAGE } from '@tourlint/shared';
import { describe, expect, it, vi } from 'vitest';
import { KtoFetchError, KtoQuotaExceededError } from '../external/kto/kto.errors';
import { RouteProviderError } from '../external/kakao/kakao.errors';
import { ForecastProviderError } from '../external/kma/kma.errors';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { DomainException, RateLimitException } from './domain.exception';

/**
 * 오류 응답은 이 필터 한 곳에서만 만든다. 외부 장애를 우리 버그와 갈라 놓는 자리이기도 하다.
 */
function run(exception: unknown): { status: number; body: Record<string, unknown>; headers: Record<string, string> } {
  let status = 0;
  let body: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  const res = {
    status: (s: number) => { status = s; return res; },
    json: (b: Record<string, unknown>) => { body = b; },
    setHeader: (name: string, value: string) => { headers[name] = value; },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ method: 'GET', url: '/api/v1/x' }),
    }),
  } as unknown as ArgumentsHost;

  const filter = new AllExceptionsFilter();
  vi.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
  filter.catch(exception, host);
  return { status, body, headers };
}

describe('빈도 제한 (EX-SY-008 · EX-AG-004 · API 3-4)', () => {
  it('🔴 분당 상한이면 429 RATE_LIMIT_EXCEEDED 와 Retry-After(초)를 싣는다', () => {
    const { status, body, headers } = run(new RateLimitException('잠시 뒤에 다시 눌러 주세요.', 42));
    expect(status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(body.reasonCode).toBe('RATE_LIMIT_EXCEEDED');
    expect(headers['Retry-After']).toBe('42');
  });

  it('같은 에이전트가 도는 중이라 막힌 것이면 언제 되는지 몰라 헤더를 붙이지 않는다', () => {
    const { status, headers } = run(new RateLimitException('이미 정리하고 있어요.', null));
    expect(status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(headers).toEqual({});
  });
});

describe('외부 서비스 장애 (EX-MS-003 · UI-ST-004)', () => {
  it('🔴 제공자를 특정하지 않는 문구로 안내한다', () => {
    const { body } = run(new RouteProviderError('kakao mobility 5xx'));
    expect(body.message).toBe(EXTERNAL_UNAVAILABLE_MESSAGE);
    expect(String(body.message)).not.toMatch(/카카오|기상청|공사|KTO|kakao/i);
  });

  it('🔴 500 INTERNAL_ERROR 로 뭉개지 않는다 — 우리 버그와 갈라야 한다', () => {
    const { status, body } = run(new KtoFetchError('detailCommon2', 'HTTP 503'));
    expect(status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body.reasonCode).toBe('KTO_FETCH_FAILED');
  });

  it('사유코드는 제공자를 특정해도 된다 — 원인을 가르는 수단이다', () => {
    expect(run(new KtoQuotaExceededError('detailCommon2', '22', '일일 한도 초과')).body.reasonCode)
      .toBe('KTO_QUOTA_EXCEEDED');
    expect(run(new ForecastProviderError('TIMEOUT')).body.reasonCode).toBe('FORECAST_UNAVAILABLE');
  });

  it('예외 메시지 원문을 응답에 싣지 않는다 (NF-SC-009)', () => {
    const { body } = run(new KtoFetchError('detailCommon2', 'serviceKey=SECRET 로 호출 실패'));
    expect(JSON.stringify(body)).not.toContain('SECRET');
  });
});

describe('그 밖의 예외', () => {
  it('도메인 예외는 사유코드와 문구를 그대로 쓴다', () => {
    const { status, body } = run(
      new DomainException(HttpStatus.FORBIDDEN, 'FORBIDDEN_ACTION', '차단 2건을 해결해야 합니다.', 'REQUEST'),
    );
    expect(status).toBe(HttpStatus.FORBIDDEN);
    expect(body).toMatchObject({ reasonCode: 'FORBIDDEN_ACTION', message: '차단 2건을 해결해야 합니다.' });
  });

  it('알 수 없는 예외는 500 INTERNAL_ERROR 다', () => {
    const { status, body } = run(new Error('부트스트랩 실패'));
    expect(status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body.reasonCode).toBe('INTERNAL_ERROR');
    expect(String(body.message)).not.toContain('부트스트랩');
  });

  it('Nest 표준 예외도 사유코드로 옮긴다', () => {
    expect(run(new NotFoundException()).body.reasonCode).toBe('NOT_FOUND');
  });
});
