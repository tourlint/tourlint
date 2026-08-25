import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // 확정안 ⑤: 에러 생성은 공통 예외 필터 한 곳에서만 + traceId 포함
  app.useGlobalFilters(new AllExceptionsFilter());
  // Railway 등 리버스 프록시 뒤에서 HTTPS 를 인식해야 Secure 세션 쿠키가 나간다 (NF-SC-002)
  app.set('trust proxy', 1);
  app.enableCors({ origin: true, credentials: true });

  setupDocs(app);

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '::');
  // eslint-disable-next-line no-console
  console.log(`TourLint API → http://localhost:${port}  ·  문서 /docs  ·  상태 /health`);
}

/**
 * `/docs` 에 라우트 목록을 띄운다.
 *
 * 그동안 무엇이 실엔진이고 무엇이 mock 인지 알려면 컨트롤러 소스를 열어야 했다. 화면을
 * 붙이는 쪽에서 그건 너무 비싸다 — 브라우저로 주소 하나 열면 되게 만든다.
 *
 * **`실엔진` 과 `mock` 을 태그로 갈라 둔다.** 목록만 보고 "이거 부르면 진짜 값이 오나" 를
 * 알 수 있어야 한다. 모의 응답을 실엔진으로 착각한 채 화면을 만들면 교체 시점에
 * 통째로 다시 만들게 된다 (NF-CO-002 · FR-OP-009).
 */
function setupDocs(app: Parameters<typeof SwaggerModule.setup>[1]): void {
  const config = new DocumentBuilder()
    .setTitle('TourLint API')
    .setDescription(
      [
        '관광상품 출시 검수 · 수요 적합성 · 데이터 신선도 관리 플랫폼.',
        '',
        '`실엔진` 태그가 붙은 것은 실제로 판정·저장이 도는 경로다.',
        '`mock` 태그는 API 명세의 응답 예시를 그대로 돌려주는 임시 라우트이며,',
        '실엔진으로 교체되는 즉시 제거된다 (NF-CO-002 · FR-OP-009).',
        '',
        '전체 계약은 `docs/notion/21_API백엔드설계.md`.',
        '',
        '출처: ⓒ한국관광공사',
      ].join('\n'),
    )
    .setVersion('v1')
    .addTag('실엔진', '판정 · 저장이 실제로 도는 경로')
    .addTag('mock', '아직 교체되지 않은 임시 라우트')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, {
    customSiteTitle: 'TourLint API',
    swaggerOptions: { docExpansion: 'list', tagsSorter: 'alpha' },
  });
}

void bootstrap();
