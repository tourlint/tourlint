import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter';

/**
 * 앱이 실제로 뜨는지 본다.
 *
 * 왜 필요한가 — 2026-08-23 배포가 부팅에서 죽었다. `audit.service.ts` 가
 * `import type { Pool } from 'pg'` 로 썼는데, 타입 전용 import 는 런타임 값이 지워져서
 * Nest 가 주입 토큰을 찾지 못한다. **빌드도 린트도 타입체크도 테스트도 전부 통과했다.**
 * 실행해 보는 테스트가 하나도 없었기 때문이다.
 *
 * DI 배선은 컴파일 타임에 검증되지 않는다. 모듈을 실제로 조립해 봐야만 드러난다.
 */
describe('앱 부팅', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Pool 은 생성 시점에 접속하지 않는다. 실제 DB 없이도 배선을 확인할 수 있다
    process.env.DATABASE_URL ??= 'postgres://boot-check@127.0.0.1:1/none';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('모듈이 조립된다 — 주입이 전부 풀린다', () => {
    expect(app).toBeDefined();
  });

  it('실엔진 엔드포인트가 등록돼 있다', () => {
    const routes = registeredRoutes(app);
    for (const r of [
      'GET /',
      'GET /api/v1/usage/budget',
      'GET /api/v1/usage/calls',
      'POST /api/v1/products/:productId/audit-jobs',
      'GET /api/v1/audit-jobs/:jobId',
      'GET /api/v1/audit-runs/:runId',
      'GET /api/v1/audit-runs/:runId/findings',
      // F08 · F09
      'POST /api/v1/products/:productId/patch-preview',
      'POST /api/v1/products/:productId/patch-applications',
      'GET /api/v1/patch-applications/:id',
      'POST /api/v1/patch-applications/:id/revert',
    ]) {
      expect(routes, r).toContain(r);
    }
  });

  it('교체된 mock 라우트가 남아 있지 않다 (NF-CO-002)', () => {
    /*
     * 같은 메서드 · 같은 경로가 mock 과 실엔진에 둘 다 있으면 **먼저 등록된 쪽이 이긴다.**
     * 실엔진을 붙였는데 mock 을 안 지우면 화면은 여전히 모의 응답을 받고, 그 사실은
     * 아무 테스트도 말해 주지 않는다 — 공사 호출을 모의로 전면 대체한 채 제출하면
     * 심사에서 제외된다 (FR-OP-009).
     *
     * 특정 경로만 세지 않고 전체에서 중복을 본다. 다음에 mock 을 걷어낼 때도 이 검사가
     * 그대로 작동해야 한다.
     */
    const routes = registeredRoutes(app);
    const seen = new Set<string>();
    const duplicated = routes.filter((r) => (seen.has(r) ? true : (seen.add(r), false)));
    expect(duplicated).toEqual([]);
  });

  it('/health 가 인증 없이 응답한다 (NF-AV-004)', () => {
    expect(registeredRoutes(app)).toContain('GET /health');
  });
});

/** Express 라우터에서 등록된 `메서드 경로` 를 긁는다 */
function registeredRoutes(app: INestApplication): string[] {
  const server = app.getHttpServer() as { _events?: { request?: { _router?: { stack?: unknown[] } } } };
  const stack = server._events?.request?._router?.stack ?? [];
  const out: string[] = [];
  for (const layer of stack as { route?: { path?: string; methods?: Record<string, boolean> } }[]) {
    const path = layer.route?.path;
    if (typeof path !== 'string') continue;
    for (const [method, on] of Object.entries(layer.route?.methods ?? {})) {
      if (on) out.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return out;
}
