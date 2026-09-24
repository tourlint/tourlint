import type { NestExpressApplication } from '@nestjs/platform-express';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

/**
 * HTTP 공통 설정. 부팅(`main.ts`)과 테스트가 같은 함수를 쓴다.
 *
 * **CORS 를 켜지 않는다** (#778). 화면은 같은 출처 `/api/*` 로만 부르고 Next rewrites 가 서버에서
 * API 로 넘긴다 — 브라우저가 API 출처를 직접 부르는 곳이 없고, `/docs` 는 요청 보내기를 껐다.
 * 전에는 `origin: true` 로 아무 Origin 이나 그대로 돌려주며 자격 증명까지 허용했다. 세션 쿠키가
 * `SameSite=Lax` 라 막혀 있었을 뿐이다. 켜는 코드는 린트가 막는다(`enableCors`).
 */
export function configureHttp(app: NestExpressApplication): void {
  // 확정안 ⑤: 에러 생성은 공통 예외 필터 한 곳에서만 + traceId 포함
  app.useGlobalFilters(new AllExceptionsFilter());
  // Railway 등 리버스 프록시 뒤에서 HTTPS 를 인식해야 Secure 세션 쿠키가 나간다 (NF-SC-002)
  app.set('trust proxy', 1);
}
