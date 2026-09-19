import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { OpenAPIObject } from '@nestjs/swagger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import type { CatalogCoverage } from '../src/openapi/apply-catalog';
import { CATALOG } from '../src/openapi/catalog';
import { buildOpenApiDocument } from '../src/openapi/setup';
import { TAGS } from '../src/openapi/tags';

/**
 * `/docs` 는 심사위원이 직접 연다 (#601).
 *
 * 67개 엔드포인트가 설명 없이 한 태그에 몰려 있던 적이 있다. 라우트를 더하거나 경로를 바꾸면
 * 설명이 따라와야 한다 — 설명 없는 라우트, 없어진 라우트를 가리키는 설명을 여기서 잡는다.
 * 문서는 `main.ts` 와 같은 경로(`NestFactory`)로 조립한 앱에서 뽑는다.
 */
describe('API 문서 (/docs)', () => {
  let app: INestApplication;
  let document: OpenAPIObject;
  let coverage: CatalogCoverage;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres://boot-check@127.0.0.1:1/none';
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    ({ document, coverage } = buildOpenApiDocument(app));
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  const operations = (): [string, Record<string, unknown>][] =>
    Object.entries(document.paths).flatMap(([path, methods]) =>
      Object.entries(methods as Record<string, Record<string, unknown>>).map(
        ([method, op]) => [`${method.toUpperCase()} ${path}`, op] as [string, Record<string, unknown>],
      ));

  it('🔴 모든 라우트에 설명이 있다 — 설명 없는 라우트가 없다', () => {
    expect(coverage.undocumented).toEqual([]);
  });

  it('🔴 설명이 가리키는 라우트가 모두 있다 — 지워지거나 바뀐 경로를 가리키지 않는다', () => {
    expect(coverage.stale).toEqual([]);
  });

  it('같은 라우트를 두 번 설명하지 않는다', () => {
    const routes = CATALOG.map((e) => e.route);
    expect(routes.filter((r, i) => routes.indexOf(r) !== i)).toEqual([]);
  });

  it('🔴 옛 태그(실엔진 · mock)가 남지 않고, 모든 엔드포인트가 흐름 태그 하나에 들어간다', () => {
    const names: readonly string[] = TAGS.map((t) => t.name);
    for (const [route, op] of operations()) {
      const tags = op.tags as string[] | undefined;
      expect(tags, route).toHaveLength(1);
      expect(names, route).toContain(tags?.[0]);
    }
    expect(JSON.stringify(document)).not.toContain('실엔진');
  });

  it('🔴 조회 파라미터가 모두 필수로 찍히지 않는다 — 설명에서 필수라고 한 것만 필수다', () => {
    for (const [route, op] of operations()) {
      const entry = CATALOG.find((e) => e.route === route);
      for (const p of (op.parameters ?? []) as { name: string; in: string; required?: boolean }[]) {
        if (p.in !== 'query') continue;
        expect(p.required, `${route} ?${p.name}`).toBe(entry?.params?.[p.name]?.required === true);
      }
    }
  });

  it('본문을 받는 엔드포인트는 예시가 있다', () => {
    for (const entry of CATALOG) {
      const method = entry.route.split(' ')[0];
      if (method === 'GET' || method === 'DELETE') continue;
      // 본문이 없는 명령(검수 요청 · 되돌리기 · 출시 등)은 비워 둘 수 있다. 있다면 예시가 있어야 한다
      if (entry.body !== undefined) expect(entry.body.example, entry.route).toBeDefined();
    }
  });

  it('로그인이 필요한 엔드포인트는 401 을, 공개 엔드포인트는 자물쇠를 달지 않는다', () => {
    for (const [route, op] of operations()) {
      const entry = CATALOG.find((e) => e.route === route);
      const responses = op.responses as Record<string, unknown>;
      if (entry?.public === true) {
        expect(op.security, route).toEqual([]);
      } else {
        expect(Object.keys(responses), route).toContain('401');
        expect(op.security, route).toEqual([{ session: [] }]);
      }
    }
  });

  it('태그 순서가 서비스 흐름 순서이고 빈 태그가 없다', () => {
    expect((document.tags ?? []).map((t) => t.name)).toEqual(TAGS.map((t) => t.name));
    const used = new Set(CATALOG.map((e) => e.tag));
    expect(TAGS.map((t) => t.name).filter((n) => !used.has(n))).toEqual([]);
  });

  /*
   * 테스트 계정은 심사위원이 함께 쓴다. Try it out 은 예시 값을 입력칸에 미리 채우므로, 쓰기 API 에
   * 공용 상품 번호가 채워져 있으면 Execute 한 번에 모두가 보는 상품이 바뀐다.
   * 아무것도 저장하지 않는 POST 만 번호를 채울 수 있다.
   */
  const READ_ONLY_POSTS = new Set([
    'POST /api/v1/products/{productId}/patch-preview',
    'POST /api/v1/products/{productId}/place-suggestions',
    'POST /api/v1/products/{productId}/place-facts',
    'POST /api/v1/audit-runs/{runId}/check-questions',
    'POST /api/v1/audit-runs/{runId}/reports',
  ]);

  it('🔴 데이터를 바꾸는 API 는 경로 번호를 미리 채우지 않는다 — 공용 계정 보호', () => {
    const prefilled: string[] = [];
    for (const [route, op] of operations()) {
      if (route.startsWith('GET ') || READ_ONLY_POSTS.has(route)) continue;
      for (const p of (op.parameters ?? []) as { name: string; in: string; example?: unknown }[]) {
        if (p.in === 'path' && p.example !== undefined) prefilled.push(`${route} {${p.name}}=${String(p.example)}`);
      }
    }
    expect(prefilled).toEqual([]);
  });

  it('🔴 설명에 400 을 적은 엔드포인트는 400 INPUT_INVALID 예시를 보인다 (#612)', () => {
    type Examples = { content?: { 'application/json'?: { examples?: Record<string, unknown> } } };
    const missing: string[] = [];
    for (const [route, op] of operations()) {
      const entry = CATALOG.find((e) => e.route === route);
      if (entry === undefined || !/\b400\b/.test(entry.description)) continue;
      const bad = (op.responses as Record<string, Examples>)['400'];
      const keys = Object.keys(bad?.content?.['application/json']?.examples ?? {});
      if (!keys.some((k) => k.startsWith('INPUT_INVALID'))) missing.push(route);
    }
    expect(missing).toEqual([]);
  });

  /*
   * 심사위원이 읽는 문서다 (#619). 규칙 번호 · 요구사항 ID · 만드는 쪽 말이 설명에 다시 들어오면
   * 빨갛다. 예시 값과 `코드` 표기(필드 이름)는 보지 않는다.
   */
  const JARGON = new RegExp([
    '(?:FR|NF|EX|PM|DR|EI|SC|TM|UI)-[A-Z0-9]{2}', 'API 설계', 'DB 명세서', 'R(?:0\\d|10)(?![0-9])',
    '원문', '지문', '배치', '픽스처', 'fixture', '캐시', '[0-9]\\s?콜', '콜[\\s·,.)]', '정규화', 'LLM', '(?<!관광)공사',
    '실엔진', 'mock', '스키마', 'finding', '재현', '결정론',
  ].join('|'));

  it('🔴 설명에 만드는 쪽 말 · 규칙 번호 · 요구사항 ID 가 없다 (#619)', () => {
    const texts: [string, string][] = [];
    const add = (where: string, text: unknown): void => {
      if (typeof text === 'string') texts.push([where, text.replace(/`[^`]*`/g, '')]);
    };
    const walkSchema = (where: string, schema: unknown): void => {
      if (typeof schema !== 'object' || schema === null) return;
      const s = schema as { description?: unknown; properties?: Record<string, unknown>; items?: unknown };
      add(where, s.description);
      for (const [k, v] of Object.entries(s.properties ?? {})) walkSchema(`${where}.${k}`, v);
      walkSchema(`${where}[]`, s.items);
    };
    add('소개글', document.info.description);
    for (const tag of document.tags ?? []) add(`태그 ${tag.name}`, tag.description);
    for (const [route, op] of operations()) {
      const o = op as {
        summary?: string; description?: string;
        parameters?: { name: string; description?: string }[];
        requestBody?: { description?: string; content?: Record<string, { schema?: unknown }> };
        responses?: Record<string, { description?: string; content?: Record<string, { schema?: unknown; examples?: Record<string, { summary?: string }> }> }>;
      };
      add(route, o.summary);
      add(route, o.description);
      for (const p of o.parameters ?? []) add(`${route} ?${p.name}`, p.description);
      add(`${route} 본문`, o.requestBody?.description);
      for (const media of Object.values(o.requestBody?.content ?? {})) walkSchema(`${route} 본문`, media.schema);
      for (const [status, res] of Object.entries(o.responses ?? {})) {
        add(`${route} ${status}`, res.description);
        for (const media of Object.values(res.content ?? {})) {
          walkSchema(`${route} ${status}`, media.schema);
          for (const ex of Object.values(media.examples ?? {})) add(`${route} ${status} 예시`, ex.summary);
        }
      }
    }
    const found = texts.filter(([, t]) => JARGON.test(t)).map(([w, t]) => `${w}: ${t.match(JARGON)?.[0] ?? ''} — ${t.slice(0, 60)}`);
    expect(found).toEqual([]);
  });

  it('🔴 일정 파일 업로드는 글자 칸이 아니라 파일 선택 칸으로 나온다', () => {
    type Media = { schema?: { properties?: Record<string, unknown> } };
    const op = document.paths['/api/v1/uploads/schedule']?.post as { requestBody?: { content?: Record<string, Media> } } | undefined;
    const file = op?.requestBody?.content?.['multipart/form-data']?.schema?.properties?.file;
    expect(file).toMatchObject({ type: 'string', format: 'binary' });
  });
});
