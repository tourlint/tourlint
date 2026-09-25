import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { DB_POOL } from '../persistence/db';
import { AllExceptionsFilter } from '../common/all-exceptions.filter';
import { demoEmail } from '../seed/demo-seed';
import { AccountRepository } from './account.repository';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LOGIN_FAILURE_LIMIT, LOGIN_FAILURE_WINDOW_MS, LoginThrottle } from './login-throttle';
import { hashPassword } from './password';
import { SignupEmailSender } from './signup-email.sender';

describe('LoginThrottle — 계정마다 실패를 센다 (NF-SC-010 · #799)', () => {
  it('정한 수만큼 틀리기 전에는 막지 않고, 그 뒤로는 창이 끝날 때까지 막는다', () => {
    let now = 0;
    const t = new LoginThrottle(() => now, 3, 60_000);
    t.recordFailure('a@x');
    t.recordFailure('a@x');
    expect(t.blockedFor('a@x')).toBeNull();
    t.recordFailure('a@x');
    expect(t.blockedFor('a@x')).toBe(60);
    now = 30_000;
    expect(t.blockedFor('a@x')).toBe(30);
    now = 60_000;
    expect(t.blockedFor('a@x')).toBeNull();
  });

  it('계정끼리 섞지 않는다', () => {
    const t = new LoginThrottle(() => 0, 1, 60_000);
    t.recordFailure('a@x');
    expect(t.blockedFor('a@x')).not.toBeNull();
    expect(t.blockedFor('b@x')).toBeNull();
  });
});

const URL = process.env.TEST_DATABASE_URL;
// 고유 스키마로 격리해 전체 스위트의 계정을 건드리지 않는다
describe.skipIf(!URL)('로그인 실패 제한 — HTTP · 실제 DB (NF-SC-010 · EX-SY-008 · #799)', () => {
  const schema = `login_throttle_${randomUUID().replaceAll('-', '')}`;
  const password = 'right-password-123';
  const mail = { requireConfigured: vi.fn(), send: vi.fn<SignupEmailSender['send']>() };
  let admin: Pool;
  let pool: Pool;
  let app: INestApplication;
  let base: string;
  let now = 0;

  beforeAll(async () => {
    admin = new Pool({ connectionString: URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: URL, options: `-c search_path=${schema}` });
    await pool.query(readFileSync(resolve(__dirname, '../../../../db/schema.sql'), 'utf8'));
    const hash = await hashPassword(password);
    const accounts = new AccountRepository(pool);
    await accounts.create('owner@example.test', hash);
    await accounts.create('other@example.test', hash);
    await accounts.create(demoEmail().trim().toLowerCase(), hash, true);

    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        AuthService, { provide: DB_POOL, useValue: pool }, { provide: SignupEmailSender, useValue: mail },
        { provide: LoginThrottle, useValue: new LoginThrottle(() => now) },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1/auth`;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(() => { now += LOGIN_FAILURE_WINDOW_MS * 2; });

  const login = (email: string, pw: string) => fetch(`${base}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw }),
  });

  it('🔴 한 계정에 10번 틀리면 맞는 비밀번호여도 429 · Retry-After 다 — 다른 계정은 그대로다', async () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) expect((await login('owner@example.test', 'wrong')).status).toBe(401);

    const blocked = await login('owner@example.test', password);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await blocked.json()).toMatchObject({ reasonCode: 'RATE_LIMIT_EXCEEDED' });

    expect((await login('other@example.test', password)).status).toBe(200);
  });

  it('창이 끝나면 풀린다', async () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) await login('owner@example.test', 'wrong');
    expect((await login('owner@example.test', password)).status).toBe(429);
    now += LOGIN_FAILURE_WINDOW_MS;
    expect((await login('owner@example.test', password)).status).toBe(200);
  });

  it('🔴 공개된 테스트 계정은 잠그지 않는다 — 심사위원 전원이 같이 쓴다', async () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT + 2; i++) expect((await login(demoEmail(), 'wrong')).status).toBe(401);
    expect((await login(demoEmail(), password)).status).toBe(200);
  });
});
