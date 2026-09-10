import { afterEach, describe, expect, it, vi } from "vitest";
import { reportApi } from "./api";

/**
 * 리포트 다운로드는 JSON 이 아니라 바이너리다. 공통 fetch 래퍼는 무조건 `.json()` 이라
 * 여기서 못 쓴다 — 그 자리를 따로 두고 이 스펙이 지킨다 (이슈 #282).
 *
 * 화면은 DOM 러너 없이 굴리므로 미리보기 렌더 자체는 여기서 안 본다. 바이트를 제대로
 * 받아 오는지가 그 앞의 조건이다.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("reportApi.fetchPdf (UI-S6-007)", () => {
  it("PDF 바이트를 그대로 준다 — 본문을 JSON 으로 읽지 않는다", async () => {
    const pdf = new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: "application/pdf" });
    globalThis.fetch = vi.fn(
      async () => new Response(pdf, { status: 200, headers: { "Content-Type": "application/pdf" } }),
    ) as unknown as typeof fetch;

    const out = await reportApi.fetchPdf("r-1");
    expect(await out.text()).toBe("%PDF");
  });

  it("세션 쿠키를 실어 보낸다 — 인증 필수 경로다 (PM-DA-007)", async () => {
    // `vi.fn()` 의 `calls` 는 인자 타입을 안 주면 빈 튜플로 추론돼 `[1]` 을 못 읽는다
    let seen: RequestInit | undefined;
    globalThis.fetch = (async (...args: unknown[]) => {
      seen = args[1] as RequestInit | undefined;
      return new Response(new Blob([]), { status: 200 });
    }) as unknown as typeof fetch;

    await reportApi.fetchPdf("r-1");
    expect(seen).toMatchObject({ credentials: "include" });
  });

  it("실패하면 서버가 준 사유를 그대로 올린다 (EX-SY-004)", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ reasonCode: "NOT_FOUND", message: "리포트가 만료되었습니다." }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    await expect(reportApi.fetchPdf("r-1")).rejects.toMatchObject({
      status: 404,
      reasonCode: "NOT_FOUND",
      message: "리포트가 만료되었습니다.",
    });
  });
});
