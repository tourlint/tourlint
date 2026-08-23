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

  it('실엔진 엔드포인트 4종이 등록돼 있다', () => {
    const paths = registeredPaths(app);
    for (const p of [
      '/api/v1/products/:productId/audit-jobs',
      '/api/v1/audit-jobs/:jobId',
      '/api/v1/audit-runs/:runId',
      '/api/v1/audit-runs/:runId/findings',
    ]) {
      expect(paths, p).toContain(p);
    }
  });

  it('교체된 mock 라우트가 남아 있지 않다 (NF-CO-002)', () => {
    // 같은 경로가 mock 과 실엔진에 둘 다 있으면 먼저 등록된 쪽이 이긴다
    const paths = registeredPaths(app);
    const audit = paths.filter((p) => p.includes('audit-jobs') || p === '/api/v1/audit-runs/:runId');
    expect(new Set(audit).size).toBe(audit.length);
  });

  it('/health 가 인증 없이 응답한다 (NF-AV-004)', () => {
    expect(registeredPaths(app)).toContain('/health');
  });
});

/** Express 라우터에서 등록된 경로를 긁는다 */
function registeredPaths(app: INestApplication): string[] {
  const server = app.getHttpServer() as { _events?: { request?: { _router?: { stack?: unknown[] } } } };
  const stack = server._events?.request?._router?.stack ?? [];
  const out: string[] = [];
  for (const layer of stack as { route?: { path?: string } }[]) {
    if (typeof layer.route?.path === 'string') out.push(layer.route.path);
  }
  return out;
}
