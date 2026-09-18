import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { SignupEmailSender, signupMailConfig } from './signup-email.sender';

const URL = 'https://script.google.com/macros/s/test-deployment/exec';
const SECRET = 'a'.repeat(64);
const ID = 'dfd9de37-e729-45bc-ac6a-97152db41909';
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function configure() {
  vi.stubEnv('AUTH_MAIL_SCRIPT_URL', URL);
  vi.stubEnv('AUTH_MAIL_SECRET', SECRET);
}
function accepted() { return new Response(JSON.stringify({ ok: true, verificationId: ID })); }

describe('Gmail · Apps Script 인증메일', () => {
  it('배포 URL과 강한 비밀값이 없으면 요청하지 않는다', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const [url, secret] of [[URL, 'short'], ['', SECRET], [URL, '']]) {
      vi.stubEnv('AUTH_MAIL_SCRIPT_URL', url); vi.stubEnv('AUTH_MAIL_SECRET', secret);
      await expect(new SignupEmailSender().send('a@example.test', '123456', ID)).rejects.toMatchObject({ status: 503 });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    'https://evil.example/macros/s/x/exec', 'http://script.google.com/macros/s/x/exec',
    'https://script.google.com.evil.example/macros/s/x/exec',
    'https://script.google.com/macros/s/x/dev', 'https://script.google.com/macros/s/x/exec?secret=x',
    'https://user:password@script.google.com/macros/s/x/exec',
  ])('허용되지 않는 배포 URL 거부: %s', (url) => {
    expect(signupMailConfig({ AUTH_MAIL_SCRIPT_URL: url, AUTH_MAIL_SECRET: SECRET })).toBeNull();
  });
  it('메일 내용·시각·요청 ID를 HMAC으로 서명하고 원본 비밀값은 보내지 않음', async () => {
    configure();
    const fetcher = vi.fn().mockResolvedValue(accepted()); vi.stubGlobal('fetch', fetcher);
    await new SignupEmailSender().send('a@example.test', '012345', ID);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe(URL);
    const body = JSON.parse(options.body);
    const signed = JSON.stringify([1, ID, body.timestamp, 'a@example.test', '012345']);
    expect(body.signature).toBe(createHmac('sha256', SECRET).update(signed).digest('hex'));
    expect(options.body).not.toContain(SECRET);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.redirect).toBe('manual');
  });
  it('Google ContentService의 결과 URL에는 GET으로만 이동, 인증코드 본문 재전송 없음', async () => {
    configure();
    const next = 'https://script.googleusercontent.com/macros/echo?user_content_key=test';
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: next } })).mockResolvedValueOnce(accepted());
    vi.stubGlobal('fetch', fetcher);
    await new SignupEmailSender().send('a@example.test', '012345', ID);
    expect(fetcher.mock.calls[1]).toEqual([next, { method: 'GET', redirect: 'error', signal: expect.any(AbortSignal) }]);
  });
  it.each(['https://evil.example/', 'https://script.googleusercontent.com.evil.example/macros/echo', 'https://user:pass@script.googleusercontent.com/macros/echo'])('리다이렉트 대상 검증: %s', async (location) => {
    configure();
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { Location: location } }));
    vi.stubGlobal('fetch', fetcher);
    await expect(new SignupEmailSender().send('a@example.test', '012345', ID)).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([JSON.stringify({ ok: false }), JSON.stringify({ ok: true, verificationId: 'other-id' }), '<html>Sign in</html>'])('HTTP 200이어도 발송 확인이 없으면 실패', async (body) => {
    configure(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    await expect(new SignupEmailSender().send('a@example.test', '012345', ID)).rejects.toMatchObject({ status: 503 });
  });
  it.each([401, 403, 429, 500])('발송 오류 %s 원문을 노출하지 않는다', async (status) => {
    configure(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret-provider-detail', { status })));
    await expect(new SignupEmailSender().send('a@example.test', '123456', ID)).rejects.toThrow('인증메일을 보내지 못했습니다.');
  });
  it('네트워크 오류와 타임아웃도 단일 안내만 반환한다', async () => {
    configure(); vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret-network-detail')));
    await expect(new SignupEmailSender().send('a@example.test', '123456', ID)).rejects.toThrow('인증메일을 보내지 못했습니다.');
  });
});
