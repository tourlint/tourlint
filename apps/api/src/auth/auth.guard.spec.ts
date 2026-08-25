import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AuthGuard } from './auth.guard';
import type { AuthService } from './auth.service';
import type { RequestWithAccount } from './current-account.decorator';
import type { SessionAccount } from './session.repository';
import { SESSION_COOKIE, SESSION_TTL_MS } from './session-cookie';

interface CookieCall {
  name: string;
  value: string;
  options: { maxAge?: number; httpOnly?: boolean };
}

/** 세션 id → 계정을 흉내 내는 최소 AuthService. `valid-session` 만 계정을 준다 */
function stubAuth(): AuthService {
  return {
    resolveSession: async (sessionId: string | undefined): Promise<SessionAccount | null> =>
      sessionId === 'valid-session' ? { accountId: 7, email: 'a@b.com', isDemo: false } : null,
  } as unknown as AuthService;
}

function stubReflector(isPublic: boolean): Reflector {
  return { getAllAndOverride: () => isPublic } as unknown as Reflector;
}

function contextWithCookie(cookie: string | undefined): {
  ctx: ExecutionContext;
  req: RequestWithAccount;
  cookies: CookieCall[];
} {
  const req = { headers: cookie === undefined ? {} : { cookie } } as RequestWithAccount;
  const cookies: CookieCall[] = [];
  const res = {
    cookie: (name: string, value: string, options: CookieCall['options']) =>
      cookies.push({ name, value, options }),
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
  return { ctx, req, cookies };
}

describe('AuthGuard', () => {
  it('@Public 라우트는 세션 없이도 통과한다', async () => {
    const guard = new AuthGuard(stubReflector(true), stubAuth());
    const { ctx } = contextWithCookie(undefined);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('세션 쿠키가 없으면 401 로 막는다 — 화면 리다이렉트가 아니라 API 레벨 (PM-AC-004)', async () => {
    const guard = new AuthGuard(stubReflector(false), stubAuth());
    const { ctx } = contextWithCookie(undefined);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('만료·위조 세션도 막는다', async () => {
    const guard = new AuthGuard(stubReflector(false), stubAuth());
    const { ctx } = contextWithCookie('tourlint_session=forged');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('유효한 세션은 통과하고 요청에 계정을 실어 둔다', async () => {
    const guard = new AuthGuard(stubReflector(false), stubAuth());
    const { ctx, req } = contextWithCookie('tourlint_session=valid-session');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.account).toEqual({ accountId: 7, email: 'a@b.com', isDemo: false });
  });

  it('유효한 세션은 쿠키 Max-Age 를 다시 밀어 슬라이딩한다', async () => {
    const guard = new AuthGuard(stubReflector(false), stubAuth());
    const { ctx, cookies } = contextWithCookie('tourlint_session=valid-session');
    await guard.canActivate(ctx);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ name: SESSION_COOKIE, value: 'valid-session' });
    expect(cookies[0]?.options.maxAge).toBe(SESSION_TTL_MS);
    expect(cookies[0]?.options.httpOnly).toBe(true);
  });

  it('막힌 요청에는 쿠키를 다시 심지 않는다 — 세션을 슬라이딩할 근거가 없다', async () => {
    const guard = new AuthGuard(stubReflector(false), stubAuth());
    const { ctx, cookies } = contextWithCookie('tourlint_session=forged');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(cookies).toHaveLength(0);
  });
});
