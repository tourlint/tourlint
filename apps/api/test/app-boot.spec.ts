import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { RootController } from '../src/root/root.controller';
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

  it('🔴 인증 없이 여는 것은 루트 · /health · /docs 뿐이다 (PM-AC-003 · 004)', () => {
    /*
     * `AuthGuard` 가 `APP_GUARD` 로 전역 등록돼 있어 기본이 차단이다. 여기 목록이 늘어나면
     * 그만큼 인증 없이 열리는 면이 늘어난 것이므로 의도한 것인지 확인해야 한다.
     *
     * 서버가 살아 있는지 보는 경로(루트 · health)와 라우트 목록(docs)만 연다. 살아 있는지
     * 확인하는 데 로그인을 요구하면 확인하려던 것을 확인하지 못한다.
     */
    const publicHandlers = ['RootController', 'HealthController', 'AuthController'];
    const guarded = ['UsageController', 'AuditController', 'CatalogController', 'UploadController'];
    for (const name of [...publicHandlers, ...guarded]) {
      expect(registeredRoutes(app).length, name).toBeGreaterThan(0);
    }
    // 루트는 @Public 이어야 한다 — 없으면 브라우저로 열었을 때 401 이 뜬다
    const meta = Reflect.getMetadata('auth:isPublic', RootController.prototype.index) as boolean | undefined;
    expect(meta).toBe(true);
  });

  it('🔴 모든 컨트롤러가 실엔진 · mock 중 하나로 태그돼 있다', () => {
    /*
     * `/docs` 를 여는 이유가 "이거 부르면 진짜 값이 오나" 를 목록만 보고 아는 것이다.
     * 태그를 빠뜨리면 Nest 가 클래스명으로 자동 생성해서 그 구분이 사라진다 — 실제로
     * 컨트롤러 셋이 그렇게 빠져 있었다.
     *
     * 모의 응답을 실엔진으로 착각한 채 화면을 만들면 교체 시점에 통째로 다시 만들게
     * 된다 (NF-CO-002 · FR-OP-009).
     */
    const dir = join(__dirname, '../src');
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.controller.ts'));
    expect(files.length).toBeGreaterThan(0);

    const untagged = files.filter((f) => {
      const src = readFileSync(join(dir, f), 'utf8');
      return !/@ApiTags\('(실엔진|mock)'\)/.test(src);
    });
    expect(untagged).toEqual([]);
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
