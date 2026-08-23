import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_RESPONSE_TIMEOUT_MS,
  readAgentTimeouts,
  resetSharedAgent,
} from './http-client';

afterEach(() => { resetSharedAgent(); });

describe('타임아웃 분리 (EI-CM-004)', () => {
  it('연결과 응답이 서로 다른 값이다 — 이게 이 파일이 존재하는 이유다', () => {
    const t = readAgentTimeouts({});
    expect(t.connectTimeout).toBe(DEFAULT_CONNECT_TIMEOUT_MS);
    expect(t.headersTimeout).toBe(DEFAULT_RESPONSE_TIMEOUT_MS);
    expect(t.connectTimeout).toBeLessThan(t.headersTimeout);
  });

  it('환경변수로 조정된다', () => {
    const t = readAgentTimeouts({ HTTP_CONNECT_TIMEOUT_MS: '1500', HTTP_RESPONSE_TIMEOUT_MS: '7000' });
    expect(t).toEqual({ connectTimeout: 1500, headersTimeout: 7000, bodyTimeout: 7000 });
  });

  it('0 과 음수는 받지 않는다 — 상한이 없으면 검수가 통째로 매달린다', () => {
    expect(readAgentTimeouts({ HTTP_CONNECT_TIMEOUT_MS: '0' }).connectTimeout).toBe(DEFAULT_CONNECT_TIMEOUT_MS);
    expect(readAgentTimeouts({ HTTP_CONNECT_TIMEOUT_MS: '-1' }).connectTimeout).toBe(DEFAULT_CONNECT_TIMEOUT_MS);
  });

  it('숫자가 아니거나 빈 값이면 기본값이다', () => {
    expect(readAgentTimeouts({ HTTP_RESPONSE_TIMEOUT_MS: '곧' }).headersTimeout).toBe(DEFAULT_RESPONSE_TIMEOUT_MS);
    expect(readAgentTimeouts({ HTTP_RESPONSE_TIMEOUT_MS: '  ' }).headersTimeout).toBe(DEFAULT_RESPONSE_TIMEOUT_MS);
  });

  it('소수는 내림한다 — undici 는 정수 밀리초를 받는다', () => {
    expect(readAgentTimeouts({ HTTP_CONNECT_TIMEOUT_MS: '2500.9' }).connectTimeout).toBe(2500);
  });
});

describe('타임아웃 판별 (호출 로그가 TIMEOUT 으로 남아야 한다)', () => {
  it('AbortSignal.timeout 의 TimeoutError 를 잡는다', async () => {
    const { isTimeoutError } = await import('./http-client');
    const e = new Error('timed out'); e.name = 'TimeoutError';
    expect(isTimeoutError(e)).toBe(true);
  });

  it('undici 연결 타임아웃을 잡는다 — 이름은 TypeError 라 cause 를 봐야 한다', async () => {
    const { isTimeoutError } = await import('./http-client');
    const e = new TypeError('fetch failed');
    (e as { cause?: unknown }).cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
    expect(isTimeoutError(e)).toBe(true);
  });

  it('헤더·본문 타임아웃도 잡는다', async () => {
    const { isTimeoutError } = await import('./http-client');
    for (const code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
      const e = new TypeError('fetch failed');
      (e as { cause?: unknown }).cause = { code };
      expect(isTimeoutError(e)).toBe(true);
    }
  });

  it('연결 거부는 타임아웃이 아니다 — 느린 것과 없는 것은 다르다', async () => {
    const { isTimeoutError } = await import('./http-client');
    const e = new TypeError('fetch failed');
    (e as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
    expect(isTimeoutError(e)).toBe(false);
    expect(isTimeoutError('문자열')).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
  });
});
