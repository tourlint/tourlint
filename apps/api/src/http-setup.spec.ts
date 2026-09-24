import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Controller, Get, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { configureHttp } from './http-setup';

@Controller('probe')
class ProbeController {
  @Get()
  read(): { ok: true } {
    return { ok: true };
  }

  @Post()
  write(): { ok: true } {
    return { ok: true };
  }
}

describe('HTTP 공통 설정 — CORS 를 켜지 않는다 (#778)', () => {
  const FOREIGN = 'https://evil.example.com';
  // 화면의 요청은 Next rewrites 를 거쳐 이 Origin 을 단 채 API 에 닿는다
  const WEB = 'https://tourlint-web.up.railway.app';
  let app: NestExpressApplication;
  let base: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false });
    configureHttp(app);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('🔴 다른 출처의 preflight 에 허용 헤더를 돌려주지 않는다', async () => {
    const res = await fetch(`${base}/probe`, {
      method: 'OPTIONS',
      headers: { Origin: FOREIGN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('🔴 다른 출처의 요청에 허용 헤더가 없다', async () => {
    const res = await fetch(`${base}/probe`, { headers: { Origin: FOREIGN } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('요청 자체는 막지 않는다 — 화면이 rewrites 로 보낸 요청은 그대로 처리된다', async () => {
    const read = await fetch(`${base}/probe`, { headers: { Origin: WEB } });
    const write = await fetch(`${base}/probe`, { method: 'POST', headers: { Origin: WEB, 'Content-Type': 'application/json' }, body: '{}' });
    expect(read.status).toBe(200);
    expect(write.status).toBe(201);
    expect(await write.json()).toEqual({ ok: true });
  });
});
