import { NextResponse, type NextRequest } from "next/server";

/**
 * 화면 접근 유도 (Next 16 Proxy — 구 middleware).
 *
 * 세션 쿠키가 없으면 로그인 화면으로 보낸다. ⚠️ 이건 편의(optimistic check)일 뿐
 * 권한의 근거가 아니다 — 실제 차단은 API 가드가 한다 (PM-AC-004). 쿠키는 `HttpOnly`
 * 라 존재 여부만 볼 수 있고 유효성은 서버가 판단한다.
 */
const SESSION_COOKIE = "tourlint_session";

export function proxy(req: NextRequest): NextResponse {
  const hasSession = req.cookies.has(SESSION_COOKIE);
  const isLoginPage = req.nextUrl.pathname === "/login";

  if (!hasSession && !isLoginPage) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  if (hasSession && isLoginPage) {
    return NextResponse.redirect(new URL("/", req.url));
  }
  return NextResponse.next();
}

/** `/api`(프록시) · 정적 자원 · 파비콘은 건드리지 않는다 */
export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
