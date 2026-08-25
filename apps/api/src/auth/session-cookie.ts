import type { CookieOptions } from 'express';

/**
 * 세션 쿠키 규약 — 한 곳에서만 정의한다.
 *
 * `HttpOnly` 로 JS 접근을 막고, `SameSite=Lax` 로 크로스사이트 요청에 안 실리게 하며,
 * 운영(HTTPS)에서는 `Secure` 를 켠다 (NF-SC-002). 로컬은 http 라 Secure 를 켜면
 * 브라우저가 쿠키를 저장하지 않으므로 운영에서만 켠다.
 *
 * 웹은 같은 오리진(`/api/*` 프록시)으로 API 를 부르므로 Lax 쿠키가 그대로 실린다.
 */
export const SESSION_COOKIE = 'tourlint_session';

/** 세션 수명. 만료되면 재인증한다 (PM-AC-006) */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function sessionCookieOptions(maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
  };
}

/** 쿠키 헤더 한 줄을 이름→값 맵으로 푼다. `cookie-parser` 의존성을 더하지 않는다 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined || header === '') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === '') continue;
    out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}
