import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { SESSION_COOKIE } from '../auth/session-cookie';
import { applyCatalog, SESSION_SCHEME, type CatalogCoverage } from './apply-catalog';
import { CATALOG } from './catalog';
import { INTRO } from './intro';

/**
 * `/docs` — 심사위원이 직접 여는 API 문서.
 *
 * Nest 가 라우트에서 뽑은 문서에 `catalog/` 의 설명을 입혀 내보낸다. 설명이 빠진 라우트는
 * `test/openapi.spec.ts` 가 잡는다.
 */
export function buildOpenApiDocument(app: INestApplication): { document: OpenAPIObject; coverage: CatalogCoverage } {
  const config = new DocumentBuilder()
    .setTitle('TourLint API')
    .setDescription(INTRO)
    .setVersion('v1')
    .addCookieAuth(
      SESSION_COOKIE,
      {
        type: 'apiKey',
        in: 'cookie',
        name: SESSION_COOKIE,
        description: '로그인(`POST /api/v1/auth/login`)하면 발급되는 세션 쿠키',
      },
      SESSION_SCHEME,
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  const coverage = applyCatalog(document, CATALOG);
  return { document, coverage };
}

export function setupOpenApi(app: INestApplication): void {
  const { document } = buildOpenApiDocument(app);
  SwaggerModule.setup('docs', app, document, {
    customSiteTitle: 'TourLint API 문서',
    customfavIcon: 'https://tourlint-web.up.railway.app/favicon.ico',
    customCss: CUSTOM_CSS,
    swaggerOptions: {
      // 묶음을 펼친 채 엔드포인트 한 줄 요약까지 보인다. 전체를 한눈에 훑을 수 있다
      docExpansion: 'list',
      // 태그 · 엔드포인트 순서는 문서에 적은 서비스 흐름 순서를 그대로 쓴다
      tagsSorter: undefined,
      operationsSorter: undefined,
      // 맨 아래 스키마 목록은 숨긴다 — 각 엔드포인트의 예시와 스키마로 충분하다
      defaultModelsExpandDepth: -1,
      defaultModelExpandDepth: 3,
      filter: true,
      deepLinking: true,
      /*
       * 호출 형식을 확인하는 문서다 (#619). Try it out 을 끈다 — 공용 테스트 계정에서 쓰기 API 를
       * 부르면 심사위원이 함께 보는 데이터가 바뀐다.
       */
      supportedSubmitMethods: [],
    },
  });
}

/** TourLint 화면과 같은 색 · 글꼴. 상단 Swagger 막대는 숨긴다 */
const CUSTOM_CSS = `
body { background: #f6f8f7; }
.swagger-ui, .swagger-ui .info .title, .swagger-ui .opblock-tag, .swagger-ui .opblock .opblock-summary-description,
.swagger-ui .markdown p, .swagger-ui .markdown li, .swagger-ui .renderedMarkdown p, .swagger-ui table, .swagger-ui .response-col_description {
  font-family: -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Pretendard', 'Noto Sans KR', 'Segoe UI', sans-serif;
}
.swagger-ui { color: #203832; }
.swagger-ui .topbar { display: none; }
.swagger-ui .wrapper { max-width: 1180px; }
.swagger-ui .info { margin: 36px 0 20px; }
.swagger-ui .info .title { color: #203832; font-size: 32px; letter-spacing: -0.02em; }
.swagger-ui .info .title small { background: #19705a; }
.swagger-ui .info .title small.version-stamp { background: #155a49; }
.swagger-ui .info .description, .swagger-ui .info .markdown { font-size: 14px; line-height: 1.7; }
.swagger-ui .info h3 { margin: 26px 0 8px; font-size: 17px; color: #203832; }
.swagger-ui .info a, .swagger-ui .markdown a { color: #19705a; }
.swagger-ui .markdown table, .swagger-ui .renderedMarkdown table { border-collapse: collapse; margin: 8px 0 4px; font-size: 13px; }
.swagger-ui .markdown table th, .swagger-ui .markdown table td,
.swagger-ui .renderedMarkdown table th, .swagger-ui .renderedMarkdown table td {
  border: 1px solid #e2e9e6; padding: 6px 10px; text-align: left; vertical-align: top; background: #fff;
}
.swagger-ui .markdown table th, .swagger-ui .renderedMarkdown table th { background: #eaf4ef; }
.swagger-ui .markdown code, .swagger-ui .renderedMarkdown code {
  background: #eaf4ef; color: #155a49; border-radius: 4px; padding: 1px 5px; font-size: 12px;
}
.swagger-ui .markdown blockquote, .swagger-ui .renderedMarkdown blockquote {
  margin: 10px 0; padding: 8px 14px; border-left: 3px solid #348d6e; background: #fff; color: #203832;
}
/* 확인용 문서라 Try it out 을 껐다. 인증 입력 버튼도 쓸 일이 없다 */
.swagger-ui .scheme-container { display: none; }
.swagger-ui .opblock-tag { border-bottom: 1px solid #e2e9e6; color: #203832; font-size: 21px; padding: 14px 6px; }
.swagger-ui .opblock-tag small { color: #5b6d67; font-size: 13px; line-height: 1.6; padding: 0 0 0 14px; }
.swagger-ui .opblock { border-radius: 10px; box-shadow: none; }
.swagger-ui .opblock .opblock-summary-description { color: #203832; font-weight: 600; font-size: 14px; }
.swagger-ui .opblock .opblock-summary-path { font-size: 13px; }
.swagger-ui .opblock-description-wrapper p, .swagger-ui .opblock-description-wrapper li { font-size: 14px; line-height: 1.7; }
.swagger-ui .btn.execute { background-color: #19705a; border-color: #19705a; }
.swagger-ui .btn.try-out__btn { border-color: #19705a; color: #19705a; }
.swagger-ui .filter-container .operation-filter-input { border-color: #cfdcd6; border-radius: 8px; }
`;
