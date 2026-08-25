import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { IS_PUBLIC } from './public.decorator';
import { SESSION_COOKIE, SESSION_TTL_MS, parseCookies, sessionCookieOptions } from './session-cookie';
import type { RequestWithAccount } from './current-account.decorator';

/**
 * 전역 인증 가드.
 *
 * 미인증 요청은 **API 레벨에서** 막는다 — 화면 리다이렉트만으로는 요건을 채우지 못한다
 * (PM-AC-004 · EX-SY-001). `@Public()` 라우트만 통과시키고, 나머지는 세션 쿠키로
 * 계정을 되찾아 요청에 실어 둔다. 되찾지 못하면 401 `NOT_AUTHENTICATED`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const req = context.switchToHttp().getRequest<RequestWithAccount>();
    const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const account = await this.auth.resolveSession(sessionId);
    if (account === null || sessionId === undefined) {
      throw new UnauthorizedException('로그인이 필요합니다.');
    }
    req.account = account;

    // 슬라이딩 세션: 활동이 있으면 쿠키 Max-Age 도 다시 민다. resolveSession 이 서버측
    // expires_at 을 이미 연장했으므로 둘을 같은 수명으로 맞춘다 (안 맞추면 서버 세션은
    // 살아 있는데 브라우저가 쿠키를 먼저 버린다). 방치로만 만료된다 (PM-AC-006).
    const res = context.switchToHttp().getResponse<Response>();
    res.cookie(SESSION_COOKIE, sessionId, sessionCookieOptions(SESSION_TTL_MS));
    return true;
  }
}
