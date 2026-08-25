import { afterEach, describe, expect, it } from 'vitest';
import { parseCookies, sessionCookieOptions } from './session-cookie';

describe('쿠키 파싱', () => {
  it('여러 쿠키에서 이름별 값을 뽑는다', () => {
    const got = parseCookies('a=1; tourlint_session=abc123; b=2');
    expect(got.tourlint_session).toBe('abc123');
    expect(got.a).toBe('1');
  });

  it('헤더가 없으면 빈 객체', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });

  it('URL 인코딩된 값을 되돌린다', () => {
    expect(parseCookies('x=%20spaced%20').x).toBe(' spaced ');
  });
});

describe('세션 쿠키 옵션 (NF-SC-002)', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  it('HttpOnly · SameSite=Lax 를 항상 켠다', () => {
    const opts = sessionCookieOptions(1000);
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
    expect(opts.maxAge).toBe(1000);
  });

  it('운영에서만 Secure 를 켠다 — 로컬 http 는 끈다', () => {
    process.env.NODE_ENV = 'production';
    expect(sessionCookieOptions(1000).secure).toBe(true);
    process.env.NODE_ENV = 'development';
    expect(sessionCookieOptions(1000).secure).toBe(false);
  });
});
