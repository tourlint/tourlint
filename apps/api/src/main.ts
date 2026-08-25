import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // 확정안 ⑤: 에러 생성은 공통 예외 필터 한 곳에서만 + traceId 포함
  app.useGlobalFilters(new AllExceptionsFilter());
  // Railway 등 리버스 프록시 뒤에서 HTTPS 를 인식해야 Secure 세션 쿠키가 나간다 (NF-SC-002)
  app.set('trust proxy', 1);
  app.enableCors({ origin: true, credentials: true });
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '::');
  // eslint-disable-next-line no-console
  console.log(`TourLint API (mock) → http://localhost:${port}  ·  health: /health`);
}
bootstrap();
