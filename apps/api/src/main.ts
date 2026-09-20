import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { setupOpenApi } from './openapi/setup';
import { getPool } from './persistence/db';
import { bootstrapDemoAccount, demoEmail } from './seed/demo-seed';
import { CatalogService } from './catalog/catalog.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // 확정안 ⑤: 에러 생성은 공통 예외 필터 한 곳에서만 + traceId 포함
  app.useGlobalFilters(new AllExceptionsFilter());
  // Railway 등 리버스 프록시 뒤에서 HTTPS 를 인식해야 Secure 세션 쿠키가 나간다 (NF-SC-002)
  app.set('trust proxy', 1);
  app.enableCors({ origin: true, credentials: true });

  // 심사위원이 직접 여는 API 문서. 설명은 `openapi/catalog` 에 모여 있다 (#601)
  setupOpenApi(app);

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '::');
  // eslint-disable-next-line no-console
  console.log(`TourLint API → http://localhost:${port}  ·  문서 /docs  ·  상태 /health`);

  await ensureDemoAccountOnBoot();
  warmCatalogOnBoot(app.get(CatalogService));
}

/**
 * 지역 · 분류 코드를 배경에서 미리 받아 둔다 (#662).
 *
 * 기다리지 않는다 — 부팅을 늦출 일이 아니고, 실패해도 사용자 요청이 다시 시도한다.
 * 로그의 걸린 시간이 운영에서 공사로 나가는 길의 상태를 말해 준다.
 */
function warmCatalogOnBoot(catalog: CatalogService): void {
  void catalog.warm((line) => {
    // eslint-disable-next-line no-console
    console.log(line);
  });
}

/**
 * 심사용 계정을 부팅 때 보장한다 (PM-TA-001).
 *
 * `listen` 뒤에 부른다 — DB 가 느리거나 막혀도 API 는 이미 응답할 수 있는 상태여야 한다.
 * 실패해도 부팅을 중단하지 않고 한 줄만 남긴다. 로그에 이메일까지만 적고 비밀번호는
 * 절대 남기지 않는다 (NF-SC-008 · DB 명세서 6-4).
 */
async function ensureDemoAccountOnBoot(): Promise<void> {
  try {
    const result = await bootstrapDemoAccount(getPool());
    // eslint-disable-next-line no-console
    console.log(
      result.status === 'skipped'
        ? '심사용 계정 건너뜀 — DEMO_ACCOUNT_PASSWORD 미설정'
        : `심사용 계정 준비 완료 · ${demoEmail()} · 시연 상품 ${result.seeded}건 적재`,
    );
  } catch (err: unknown) {
    // eslint-disable-next-line no-console
    console.error('심사용 계정 준비 실패:', err instanceof Error ? err.message : err);
  }
}

void bootstrap();
