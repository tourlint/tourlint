import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';

const source = readFileSync(resolve(__dirname, '../../../../scripts/signup-mail/Code.gs'), 'utf8');
const secret = 'b'.repeat(64);
function signed(overrides: Record<string, unknown> = {}) {
  const p = { version: 1, verificationId: randomUUID(), timestamp: Date.now(), email: 'test@example.test', code: '012345', ...overrides };
  return { ...p, signature: createHmac('sha256', secret).update(JSON.stringify([p.version, p.verificationId, p.timestamp, p.email, p.code])).digest('hex') };
}
function script() {
  const properties = new Map<string, string>([['AUTH_MAIL_SECRET', secret]]);
  const send = vi.fn();
  const lock = { tryLock: vi.fn(() => true), releaseLock: vi.fn() };
  const quota = vi.fn(() => 100);
  const context = {
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key: string) => properties.get(key) ?? null,
      setProperty: (key: string, value: string) => properties.set(key, value),
      deleteProperty: (key: string) => properties.delete(key),
      getProperties: () => Object.fromEntries(properties),
    }) },
    LockService: { getScriptLock: () => lock },
    MailApp: { sendEmail: send, getRemainingDailyQuota: quota },
    Utilities: {
      Charset: { UTF_8: 'utf8' }, DigestAlgorithm: { SHA_256: 'sha256' },
      computeHmacSha256Signature: (text: string, key: string) => [...createHmac('sha256', key).update(text).digest()],
      computeDigest: (_algorithm: string, text: string) => [...createHash('sha256').update(text).digest()],
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text: string) => ({ setMimeType: () => JSON.parse(text) }) },
  };
  runInNewContext(source, context);
  const handlers = context as typeof context & { doPost: (e: unknown) => { ok: boolean; verificationId?: string }; doGet: () => unknown; authorizeMail: () => unknown };
  return { properties, send, lock, quota, handlers, post: (body: unknown) => handlers.doPost({ postData: { contents: JSON.stringify(body) } }) };
}

describe('배포할 Apps Script 원본 보안 계약', () => {
  it('서명된 요청은 고정 템플릿으로 한 명에게만 보내고 발송 결과만 응답', () => {
    const s = script(), body = signed();
    expect(s.post(body)).toEqual({ ok: true, verificationId: body.verificationId });
    expect(s.send.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ to: body.email, name: 'TourLint', subject: '[TourLint] 회원가입 이메일 인증코드' }));
    expect(s.send.mock.calls[0]?.[0].body).toContain('012345');
    expect(s.lock.releaseLock).toHaveBeenCalledOnce();
    const stored = s.properties.get('signup:' + body.verificationId)!;
    expect(stored).not.toContain(body.email); expect(stored).not.toContain(body.code);
  });
  it('서명 없는 요청·위조·이메일 또는 코드 변경은 발송하지 않음', () => {
    const s = script(), body = signed();
    for (const changed of [ { ...body, signature: undefined }, { ...body, signature: '0'.repeat(64) },
      { ...body, email: 'attacker@example.test' }, { ...body, code: '123456' } ]) {
      expect(s.post(changed)).toEqual({ ok: false });
    }
    expect(s.send).not.toHaveBeenCalled(); expect(s.lock.tryLock).not.toHaveBeenCalled();
  });
  it.each([-121_000, 121_000])('120초 밖의 요청 거부 (%s ms)', offset => {
    const s = script(); expect(s.post(signed({ timestamp: Date.now() + offset }))).toEqual({ ok: false });
    expect(s.send).not.toHaveBeenCalled();
  });
  it.each([{ email: 'a@example.test,b@example.test' }, { email: 'a,b@example.test' }, { code: '12345' }, { code: 123456 },
    { verificationId: 'bad-id' }, { version: 2 }, { timestamp: 'bad-time' }])('잘못된 필드 거부 (%j)', fields => {
    const s = script(); expect(s.post(signed(fields))).toEqual({ ok: false }); expect(s.send).not.toHaveBeenCalled();
  });
  it('같은 서명 요청을 반복해도 한 번만 발송', () => {
    const s = script(), body = signed();
    expect(s.post(body).ok).toBe(true); expect(s.post(body).ok).toBe(true);
    expect(s.send).toHaveBeenCalledOnce();
  });
  it('같은 ID의 다른 메일·코드 요청은 새 서명이 있어도 거부', () => {
    const s = script(), body = signed(); s.post(body);
    expect(s.post(signed({ verificationId: body.verificationId, code: '654321' }))).toEqual({ ok: false });
    expect(s.send).toHaveBeenCalledOnce();
  });
  it('권한 또는 발송 실패는 재시도 중복 없이 일반 실패만 반환', () => {
    const s = script(), body = signed(); s.send.mockImplementation(() => { throw new Error('provider detail'); });
    expect(s.post(body)).toEqual({ ok: false }); expect(s.post(body)).toEqual({ ok: false });
    expect(s.send).toHaveBeenCalledOnce(); expect(s.lock.releaseLock).toHaveBeenCalledTimes(2);
  });
  it('잔여 한도가 없으면 발송하지 않는다', () => {
    const s = script(); s.quota.mockReturnValue(0);
    expect(s.post(signed())).toEqual({ ok: false }); expect(s.send).not.toHaveBeenCalled();
  });
  it('동시 실행 잠금을 얻지 못하면 발송하지 않는다', () => {
    const s = script(); s.lock.tryLock.mockReturnValue(false);
    expect(s.post(signed())).toEqual({ ok: false }); expect(s.send).not.toHaveBeenCalled();
  });
  it('비밀값 미설정·잘못된 JSON·과도한 본문 거부', () => {
    const s = script();
    expect(s.post({ ...signed(), padding: 'x'.repeat(2049) })).toEqual({ ok: false });
    expect(s.handlers.doPost({ postData: { contents: '{invalid' } })).toEqual({ ok: false });
    s.properties.delete('AUTH_MAIL_SECRET');
    expect(s.post(signed())).toEqual({ ok: false });
    expect(s.send).not.toHaveBeenCalled();
  });
  it('약한 비밀값에 대한 올바른 서명도 거부', () => {
    const s = script(), body = signed(); s.properties.set('AUTH_MAIL_SECRET', 'weak');
    body.signature = createHmac('sha256', 'weak').update(JSON.stringify([1, body.verificationId, body.timestamp, body.email, body.code])).digest('hex');
    expect(s.post(body)).toEqual({ ok: false }); expect(s.send).not.toHaveBeenCalled();
  });
  it('만료 처리 이력만 정리하고 다른 설정·비밀값은 보존', () => {
    const s = script();
    s.properties.set('signup:expired', JSON.stringify({ expiresAt: Date.now() - 1 }));
    s.properties.set('other-setting', 'retained');
    s.post(signed()); expect(s.properties.has('signup:expired')).toBe(false);
    expect(s.properties.get('AUTH_MAIL_SECRET')).toBe(secret); expect(s.properties.get('other-setting')).toBe('retained');
  });
  it('GET·최초 권한 확인은 주소·키·코드를 노출하거나 메일을 보내지 않는다', () => {
    const s = script(); expect(s.handlers.doGet()).toEqual({ service: 'tourlint-signup-mail' });
    expect(s.handlers.authorizeMail()).toBe(100); expect(s.send).not.toHaveBeenCalled();
  });
});
