import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';

/**
 * `/` — 여기가 무엇이고 어디를 봐야 하는지 알려준다.
 *
 * 원래는 404 였다. API 서버에 루트 라우트가 없는 건 정상이지만, 브라우저로 주소를 친
 * 사람 눈에는 오류 화면이다. 실제로 2026-08-25 에 팀원이 서버가 죽은 줄 알았다.
 *
 * 심사위원이 제출된 URL 로 접속했을 때 서비스가 응답하지 않으면 기능 구현 여부와 무관하게
 * 평가가 불가능하다(NF-AV 도입부). 제출 URL 은 화면이 되겠지만, API 주소를 여는 경로도
 * 분명 생긴다.
 *
 * 값은 담지 않는다 — 인증키도 DB 주소도 여기 없다 (NF-SC-009).
 *
 * `/health` 와 같이 **인증 없이 연다.** 서버가 살아 있는지 확인하는 경로에 로그인을
 * 요구하면 확인하려던 것을 확인하지 못한다.
 */
@ApiTags('실엔진')
@Controller()
export class RootController {
  @Public()
  @Get()
  index(): Record<string, unknown> {
    return {
      service: 'TourLint API',
      description: '관광상품 출시 검수 · 수요 적합성 · 데이터 신선도 관리',
      docs: '/docs',
      openapi: '/docs-json',
      health: '/health',
      apiBase: '/api/v1',
      source: '출처: ⓒ한국관광공사',
    };
  }
}
