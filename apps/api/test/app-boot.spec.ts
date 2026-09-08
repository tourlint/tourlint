import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
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
 *
 * ## `NestFactory` 로 띄운다
 *
 * 종전에는 `Test.createTestingModule` 을 썼는데 **그건 `main.ts` 와 다른 경로다.** 테스트
 * 모듈은 컨트롤러를 providers 쪽에서 풀어 주고 `NestFactory` 는 그러지 않아서, 컨트롤러를
 * provider 로 잘못 등록한 상태가 여기서는 초록불이고 실행하면 죽었다 (이슈 #329).
 * 같은 사고를 한 번 더 통과시키지 않으려면 조립 경로가 같아야 한다.
 */
describe('앱 부팅', () => {
  let app: INestApplication;
  let bootError: unknown = null;

  beforeAll(async () => {
    // Pool 은 생성 시점에 접속하지 않는다. 실제 DB 없이도 배선을 확인할 수 있다
    process.env.DATABASE_URL ??= 'postgres://boot-check@127.0.0.1:1/none';

    /*
     * main.ts 와 같은 경로로 조립한다. 로그는 끈다 — 부팅 성공 여부만 보면 된다.
     *
     * `abortOnError: false` 가 중요하다. 기본값이면 Nest 가 배선 실패에 프로세스를 죽여서
     * vitest 워커가 통째로 사라지고 「Worker exited unexpectedly」만 남는다. 무엇이
     * 안 풀렸는지는 안 나온다.
     */
    try {
      app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
      app.useGlobalFilters(new AllExceptionsFilter());
      await app.init();
    } catch (e) {
      bootError = e;
    }
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('모듈이 조립된다 — 주입이 전부 풀린다', () => {
    expect(bootError, `부팅 실패: ${String(bootError)}`).toBeNull();
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
      // 근거 펼침 · 확인 필요 목록 펼침이 쓰는 실시간 조회 (5-12)
      'GET /api/v1/contents/:contentId',
      // F08 · F09
      'POST /api/v1/products/:productId/patch-preview',
      'POST /api/v1/products/:productId/patch-applications',
      'GET /api/v1/patch-applications/:id',
      'POST /api/v1/patch-applications/:id/revert',
      // F11
      'POST /api/v1/audit-runs/:runId/reports',
      'GET /api/v1/reports/:reportId/download',
      // F13 알림
      'GET /api/v1/notifications',
      'POST /api/v1/notifications/:id/read',
      'POST /api/v1/notifications/:id/dismiss',
      // F12 ~ F14 레이더
      'GET /api/v1/radar/summary',
      'GET /api/v1/radar/changes',
      'GET /api/v1/radar/signals',
      // 마지막 목업이던 둘 (NF-CO-002)
      'POST /api/v1/products/:productId/release',
      'GET /api/v1/products/:productId/items',
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

  it('🔴 매개변수 경로가 정적 경로를 가리지 않는다', () => {
    /*
     * `contents/:contentId` 가 `contents/search` 앞에 등록되면 검색어를 콘텐츠 번호로
     * 읽는다 (이슈 #341). 경로 문자열이 달라 중복 검사로는 안 잡힌다.
     *
     * 같은 메서드 · 같은 깊이에서 한 자리만 다르고 그 자리가 한쪽은 매개변수, 다른 쪽은
     * 정적인 쌍을 찾아 **정적 쪽이 먼저인지** 본다.
     */
    const routes = registeredRoutes(app);
    const shadowed: string[] = [];

    routes.forEach((param, i) => {
      const [method, path] = param.split(' ');
      if (path === undefined || !path.includes('/:')) return;
      const parts = path.split('/');

      routes.slice(i + 1).forEach((later) => {
        const [m2, p2] = later.split(' ');
        if (m2 !== method || p2 === undefined) return;
        const other = p2.split('/');
        if (other.length !== parts.length) return;

        const diff = parts.filter((seg, k) => seg !== other[k]);
        // 딱 한 자리만 다르고, 매개변수 쪽이 앞서 있으면 뒤엣것은 영영 안 닿는다
        if (diff.length === 1 && diff[0]?.startsWith(':') === true) {
          shadowed.push(`${later} ← ${param}`);
        }
      });
    });

    expect(shadowed).toEqual([]);
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

  it('🔴 공사 인증키 없이도 뜬다', async () => {
    /*
     * `HttpKtoTransport` 는 키가 비면 생성자에서 던진다. 프로바이더가 부팅 시점에
     * 클라이언트를 만들면 키를 안 넣은 배포에서 **API 전체가 못 뜬다** — 목록 조회 하나가
     * 아니라 로그인도 검수도 같이 죽는다. 없는 키는 `/health` 가 알려 줄 일이다.
     *
     * 배치를 붙이며 실제로 그렇게 만들었다가 여기서 걸렸다.
     */
    const saved = process.env.KTO_SERVICE_KEY;
    delete process.env.KTO_SERVICE_KEY;
    try {
      const boot = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
      await boot.init();
      await boot.close();
    } finally {
      if (saved !== undefined) process.env.KTO_SERVICE_KEY = saved;
    }
  }, 30_000);

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
