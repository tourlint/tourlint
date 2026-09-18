import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignupEmailSender } from './signup-email.sender';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function configure() {
  vi.stubEnv('RESEND_API_KEY', 'test-key');
  vi.stubEnv('AUTH_EMAIL_FROM', 'TourLint <noreply@example.test>');
}
describe('Resend 인증메일', () => {
  it('발송키 또는 발신 주소가 없으면 요청 자체를 보내지 않는다', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    for (const [key, from] of [['', 'sender@example.test'], ['key', '']]) {
      vi.stubEnv('RESEND_API_KEY', key); vi.stubEnv('AUTH_EMAIL_FROM', from);
      await expect(new SignupEmailSender().send('a@example.test', '123456', 'id')).rejects.toMatchObject({ status: 503 });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('고정 HTTPS 주소·멱등키·10분 안내 및 코드가 담긴 메일을 발송한다', async () => {
    configure();
    const fetcher = vi.fn().mockResolvedValue(new Response('{"id":"sent"}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    await new SignupEmailSender().send('a@example.test', '012345', 'challenge-id');
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(options.headers['Idempotency-Key']).toBe('signup/challenge-id');
    const body = JSON.parse(options.body);
    expect(body.to).toEqual(['a@example.test']);
    expect(body.text).toContain('012345');
    expect(body.text).toContain('10분');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it.each([401, 403, 429, 500])('발송 오류 %s 원문을 노출하지 않는다', async (status) => {
    configure();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret-provider-detail', { status })));
    await expect(new SignupEmailSender().send('a@example.test', '123456', 'id')).rejects.toThrow('인증메일을 보내지 못했습니다.');
  });
  it('네트워크 오류와 타임아웃도 단일 안내만 반환한다', async () => {
    configure();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret-network-detail')));
    await expect(new SignupEmailSender().send('a@example.test', '123456', 'id')).rejects.toThrow('인증메일을 보내지 못했습니다.');
  });
});
