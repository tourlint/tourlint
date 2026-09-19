import type { Endpoint } from '../types';

export const STATUS: readonly Endpoint[] = [
  {
    route: 'GET /',
    tag: '서비스 상태',
    summary: 'API 안내',
    description: '서비스 이름과 문서 · 상태 확인 주소를 돌려줍니다.',
    public: true,
    responses: {
      200: {
        description: '성공',
        example: {
          service: 'TourLint API',
          description: '관광상품 출시 검수 · 수요 적합성 · 데이터 신선도 관리',
          docs: '/docs',
          openapi: '/docs-json',
          health: '/health',
          apiBase: '/api/v1',
          source: '출처: ⓒ한국관광공사',
        },
      },
    },
  },
  {
    route: 'GET /health',
    tag: '서비스 상태',
    summary: '서버 상태',
    description: '서버와 데이터베이스가 정상인지, 외부 데이터 연동 설정이 갖춰졌는지 돌려줍니다.',
    public: true,
    responses: {
      200: {
        description: '성공',
        example: {
          status: 'ok',
          ready: true,
          db: 'up',
          mode: 'live',
          checks: {
            database: 'up',
            schema: 'ok',
            tableCount: 20,
            expectedTableCount: 20,
            ktoServiceKey: 'ok',
            kakaoRestApiKey: 'ok',
            kmaServiceKey: 'ok',
            llmApiKey: 'ok',
            signupEmail: 'ok',
          },
          commit: '6ea4fef',
          latencyMs: 23,
          timestamp: '2026-09-19T12:51:43.795Z',
        },
      },
    },
  },
];
