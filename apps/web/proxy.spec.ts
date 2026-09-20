import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

/**
 * 세션 쿠키가 없으면 로그인으로 보낸다. 다만 심사위원 가이드 PDF 는 예외다 — 노션을 못 여는
 * 환경을 위한 파일인데 로그인으로 보내면 그 환경에서 받을 길이 없다 (#609).
 */
const at = (path: string, session = false): NextRequest =>
  new NextRequest(new URL(`https://tourlint-web.up.railway.app${path}`), {
    headers: session ? { cookie: "tourlint_session=x" } : {},
  });

describe("화면 접근 유도", () => {
  it("🔴 가이드 PDF 는 로그인 없이 받는다", () => {
    const res = proxy(at("/judge-guide.pdf"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("나머지 화면은 그대로 로그인으로 보낸다", () => {
    expect(proxy(at("/")).headers.get("location")).toContain("/login");
    expect(proxy(at("/products/1")).headers.get("location")).toContain("/login");
  });

  it("로그인한 사람이 로그인 화면에 오면 홈으로 보낸다", () => {
    expect(proxy(at("/login", true)).headers.get("location")).toMatch(/\/$/);
  });
});
