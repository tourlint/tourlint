import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService, type AuthedSession } from './auth.service';
import { Public } from './public.decorator';
import { CurrentAccount } from './current-account.decorator';
import type { SessionAccount } from './session.repository';
import { SESSION_COOKIE, sessionCookieOptions, parseCookies } from './session-cookie';

/**
 * 인증 (S0 · FR-CM-001~004).
 *
 * 회원가입 · 로그인 · 로그아웃은 세션 쿠키를 설정·삭제하므로 응답 객체에 직접 손을 댄다
 * (`passthrough: true` — 반환값 직렬화는 그대로 두고 쿠키만 얹는다).
 */
@ApiTags('실엔진')
@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('signup')
  @HttpCode(201)
  async signup(
    @Body() body: AuthBody | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccountView> {
    return this.issue(await this.auth.signup(readEmail(body), readPassword(body)), res);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: AuthBody | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccountView> {
    return this.issue(await this.auth.login(readEmail(body), readPassword(body)), res);
  }

  /**
   * 로그아웃. 세션 행을 지우고(서버측 무효화, PM-AC-005) 쿠키를 없앤다.
   * 이미 무효한 세션으로 불러도 무해하게 성공한다 — 그래서 가드를 태우지 않는다.
   */
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions(0));
  }

  /** 현재 로그인 계정. 데모 계정 여부는 화면이 배치 토글 노출을 가르는 데 쓴다 (PM-TA-006) */
  @Get('me')
  me(@CurrentAccount() account: SessionAccount): AccountView {
    return { email: account.email, isDemo: account.isDemo };
  }

  private issue(session: AuthedSession, res: Response): AccountView {
    const maxAge = Math.max(0, session.expiresAt.getTime() - Date.now());
    res.cookie(SESSION_COOKIE, session.sessionId, sessionCookieOptions(maxAge));
    return { email: session.account.email, isDemo: session.account.isDemo };
  }
}

interface AuthBody {
  email?: unknown;
  password?: unknown;
}

interface AccountView {
  email: string;
  isDemo: boolean;
}

function readEmail(body: AuthBody | undefined): string {
  return typeof body?.email === 'string' ? body.email : '';
}

function readPassword(body: AuthBody | undefined): string {
  return typeof body?.password === 'string' ? body.password : '';
}
