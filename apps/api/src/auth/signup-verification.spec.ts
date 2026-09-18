import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { DB_POOL } from '../persistence/db';
import { AllExceptionsFilter } from '../common/all-exceptions.filter';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { SignupEmailSender } from './signup-email.sender';
import { SignupVerificationRepository } from './signup-verification.repository';
import { AccountRepository } from './account.repository';
import { hashPassword } from './password';

const URL = process.env.TEST_DATABASE_URL;
// 고유 스키마로 격리해 전체 스위트의 계정·발송 한도를 건드리지 않는다.
describe.skipIf(!URL)('이메일 인증 가입 — HTTP · 실제 DB', () => {
  const schema = `signup_test_${randomUUID().replaceAll('-', '')}`;
  const email = 'new@example.test';
  const password = 'test-password-123';
  const mail = { requireConfigured: vi.fn(), send: vi.fn<SignupEmailSender['send']>() };
  let admin: Pool;
  let pool: Pool;
  let app: INestApplication;
  let base: string;
  let repo: SignupVerificationRepository;
  let auth: AuthService;

  beforeAll(async () => {
    admin = new Pool({ connectionString: URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: URL, options: `-c search_path=${schema}` });
    await pool.query(readFileSync(resolve(__dirname, '../../../../db/schema.sql'), 'utf8'));
    repo = new SignupVerificationRepository(pool);
    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [AuthService, { provide: DB_POOL, useValue: pool },
        { provide: SignupEmailSender, useValue: mail }, { provide: APP_GUARD, useClass: AuthGuard }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1/auth`;
    auth = app.get(AuthService);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE signup_verification, auth_email_rate_limit, account CASCADE');
    mail.requireConfigured.mockReset();
    mail.send.mockReset().mockResolvedValue(undefined);
  });
  const post = (path: string, body: unknown) => fetch(`${base}/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  async function requestCode(address = email) {
    const response = await post('signup-code', { email: address });
    expect(response.status).toBe(200);
    const challenge = await response.json() as { verificationId: string; expiresAt: string; resendAfterSeconds: number };
    const code = mail.send.mock.calls.at(-1)?.[1];
    expect(code).toMatch(/^\d{6}$/);
    return { ...challenge, code: code! };
  }
  async function signup(challenge: { verificationId: string; code: string }, address = email) {
    return post('signup', { email: address, password, ...challenge });
  }
  async function ageSend(minutes = 2) {
    await pool.query(`UPDATE signup_verification SET last_sent_at = now() - $1 * interval '1 minute'`, [minutes]);
  }

  it('이메일 정규화, 발송 메타데이터만 응답, 확인 전 계정·세션 없음', async () => {
    const response = await post('signup-code', { email: ' NEW@Example.Test ' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'resendAfterSeconds', 'verificationId']);
    expect(body.resendAfterSeconds).toBe(60);
    expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(590_000);
    expect(mail.send.mock.calls[0]?.[0]).toBe(email);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect((await pool.query('SELECT * FROM account')).rowCount).toBe(0);
    expect((await pool.query('SELECT * FROM session')).rowCount).toBe(0);
    const row = (await pool.query('SELECT * FROM signup_verification')).rows[0];
    expect(row.code_hash).toMatch(/^scrypt\$/);
    expect(row.code_hash).not.toBe(mail.send.mock.calls[0]?.[1]);
  });
  it('올바른 코드로 계정·기본 설정·세션 생성, 세션으로 me 접근', async () => {
    const challenge = await requestCode();
    const response = await signup(challenge);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ email, isDemo: false });
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect((await fetch(`${base}/me`, { headers: { Cookie: cookie.split(';')[0]! } })).status).toBe(200);
    expect((await pool.query('SELECT * FROM user_setting')).rowCount).toBe(1);
    expect((await pool.query('SELECT code_hash FROM signup_verification')).rows[0].code_hash).toBeNull();
  });
  it('기존 직접 가입 API 호출은 코드 없이는 계정·세션을 만들지 못함', async () => {
    expect((await post('signup', { email, password })).status).toBe(400);
    expect((await pool.query('SELECT * FROM account')).rowCount).toBe(0);
    expect((await pool.query('SELECT * FROM session')).rowCount).toBe(0);
  });
  it('다른 이메일의 인증코드로 가입 불가', async () => {
    expect((await signup(await requestCode(), 'other@example.test')).status).toBe(400);
    expect((await pool.query('SELECT * FROM account')).rowCount).toBe(0);
  });
  it('틀린 코드 5회는 DB에 누적되고 이후 정답도 거부', async () => {
    const challenge = await requestCode();
    const wrong = challenge.code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await signup({ ...challenge, code: wrong })).status).toBe(400);
    expect((await pool.query('SELECT attempts FROM signup_verification')).rows[0].attempts).toBe(5);
    expect((await signup(challenge)).status).toBe(400);
    expect((await pool.query('SELECT * FROM account')).rowCount).toBe(0);
  });
  it('만료 코드 거부', async () => {
    const challenge = await requestCode();
    await pool.query(`UPDATE signup_verification SET expires_at = now() - interval '1 second'`);
    expect((await signup(challenge)).status).toBe(400);
  });
  it('미발송 코드 거부', async () => {
    const challenge = await repo.reserve(email);
    expect((await signup(challenge)).status).toBe(400);
  });
  it('존재하지 않는 challenge 및 잘못된 타입 거부', async () => {
    expect((await signup({ verificationId: randomUUID(), code: '123456' })).status).toBe(400);
    expect((await post('signup', { email, password, verificationId: {}, code: 123456 })).status).toBe(400);
  });
  it('소비된 코드로 새 계정을 다시 만들 수 없음 — 이메일 unique 제약과 독립적으로 검사', async () => {
    const challenge = await requestCode();
    expect((await signup(challenge)).status).toBe(201);
    await pool.query('DELETE FROM account WHERE email = $1', [email]);
    expect((await signup(challenge)).status).toBe(400);
    expect((await pool.query('SELECT * FROM account')).rowCount).toBe(0);
  });
  it('동시 코드 소비는 콜백을 정확히 한 번 실행', async () => {
    const challenge = await requestCode();
    const create = vi.fn(async () => 'created');
    const results = await Promise.allSettled([1, 2, 3].map(() => repo.consume(email, challenge.verificationId, challenge.code, create)));
    expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('계정 생성 실패 시 코드 소비도 롤백되어 재시도 가능', async () => {
    const c = await requestCode();
    await expect(repo.consume(email, c.verificationId, c.code, async () => { throw new Error('insert failed'); })).rejects.toThrow('insert failed');
    expect((await signup(c)).status).toBe(201);
  });
  it('즉시 재전송 429 · Retry-After 및 실제 추가 발송 없음', async () => {
    await requestCode();
    const response = await post('signup-code', { email });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(mail.send).toHaveBeenCalledTimes(1);
  });
  it('재전송 시 옛 코드 무효화, 새 코드로 가입', async () => {
    const old = await requestCode();
    await ageSend();
    const next = await requestCode();
    expect(next.verificationId).not.toBe(old.verificationId);
    expect((await signup(old)).status).toBe(400);
    expect((await signup(next)).status).toBe(201);
  });
  it('이메일별 시간당 5회 발송 제한, 한 시간 뒤 복구', async () => {
    await requestCode();
    await ageSend();
    await pool.query('UPDATE signup_verification SET send_count = 5');
    expect((await post('signup-code', { email })).status).toBe(429);
    await pool.query(`UPDATE signup_verification SET window_started_at = now() - interval '61 minutes'`);
    await requestCode();
    expect((await pool.query('SELECT send_count FROM signup_verification')).rows[0].send_count).toBe(1);
  });
  it.each([['minute', 60_000, 10], ['day', 86_400_000, 100]] as const)('전역 %s 한도로 임의의 다른 주소 발송도 제한', async (scope, duration, count) => {
    // 분 경계에서도 현재 버킷과 바로 다음 버킷을 채운다.
    const period = Math.floor(Date.now() / duration);
    for (const n of [period, period + 1]) await pool.query('INSERT INTO auth_email_rate_limit VALUES ($1, $2, $3)', [`${scope}:${n}`, count, new Date((n + 1) * duration)]);
    expect((await post('signup-code', { email })).status).toBe(429);
    expect(mail.send).not.toHaveBeenCalled();
  });
  it('발송 실패 시 코드 무효화 및 계정 미생성', async () => {
    mail.send.mockRejectedValueOnce(new Error('test delivery failure'));
    await expect(auth.requestSignupCode(email)).rejects.toThrow('test delivery failure');
    const row = (await pool.query('SELECT code_hash, delivered FROM signup_verification')).rows[0];
    expect(row).toEqual({ code_hash: null, delivered: false });
    expect((await pool.query('SELECT * FROM account')).rowCount).toBe(0);
  });
  it('발송 설정 누락 시 한도·인증코드 예약도 하지 않음', async () => {
    mail.requireConfigured.mockImplementationOnce(() => { throw new Error('not configured'); });
    await expect(auth.requestSignupCode(email)).rejects.toThrow('not configured');
    expect((await pool.query('SELECT * FROM signup_verification')).rowCount).toBe(0);
    expect(mail.send).not.toHaveBeenCalled();
  });
  it('기존 일반·심사용 계정은 인증 요청 없이 로그인 가능', async () => {
    const accounts = new AccountRepository(pool);
    for (const isDemo of [false, true]) {
      const address = `${isDemo}@example.test`;
      await accounts.create(address, await hashPassword(password), isDemo);
      const response = await post('login', { email: address, password });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ email: address, isDemo });
    }
    expect(mail.send).not.toHaveBeenCalled();
  });
  it('이미 있는 계정도 요청 응답은 같고 가입으로 비밀번호를 바꾸지 못함', async () => {
    const accounts = new AccountRepository(pool);
    await accounts.create(email, await hashPassword('original-password'));
    expect((await signup(await requestCode())).status).toBe(400);
    expect((await post('login', { email, password: 'original-password' })).status).toBe(200);
    expect((await post('login', { email, password })).status).toBe(401);
  });
  it('잘못된 이메일·과도한 비밀번호 거부', async () => {
    for (const address of ['invalid', 'a,b@example.test', 'a'.repeat(255) + '@example.test', {}]) {
      expect((await post('signup-code', { email: address })).status).toBe(400);
    }
    expect((await post('signup', { email, password: 'x'.repeat(129) })).status).toBe(400);
    expect(mail.send).not.toHaveBeenCalled();
  });
  it('24시간 지난 임시 인증 데이터와 만료 한도를 정리, 활성 인증 보존', async () => {
    await requestCode();
    await repo.cleanup();
    expect((await pool.query('SELECT * FROM signup_verification')).rowCount).toBe(1);
    await pool.query(`UPDATE signup_verification SET last_sent_at = now() - interval '25 hours'`);
    await pool.query(`UPDATE auth_email_rate_limit SET expires_at = now() - interval '1 second'`);
    await auth.cleanupSignupCodes();
    expect((await pool.query('SELECT * FROM signup_verification')).rowCount).toBe(0);
    expect((await pool.query('SELECT * FROM auth_email_rate_limit')).rowCount).toBe(0);
  });
});
