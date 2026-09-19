import type { Endpoint } from '../types';

export const STATUS: readonly Endpoint[] = [
  {
    route: 'GET /',
    tag: '0. 서비스 상태',
    summary: 'API 안내',
    description: '이 API 의 이름과 문서 · 상태 확인 주소를 돌려준다. 주소를 처음 연 사람이 어디로 가야 하는지 알려 주는 용도다.',
    public: true,
    calls: '없음',
    responses: {
      200: {
        description: '서비스 안내',
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
    tag: '0. 서비스 상태',
    summary: '서버 상태 · 배포 커밋',
    description: [
      'DB 연결, 스키마(테이블 수), 외부 연동 키 설정 여부, 지금 떠 있는 커밋을 돌려준다.',
      '',
      '- `ready` 는 DB · 스키마 · 공사 · 카카오 · 기상청 키가 모두 갖춰지고 실호출(`mode: live`) 모드일 때만 `true` 다.',
      '- 키 **값**은 내보내지 않는다. 들어 있는지(`ok` · `missing`)만 말한다.',
      '- 배포 확인은 이 응답의 `commit` 을 `main` 의 최신 커밋과 비교한다.',
    ].join('\n'),
    public: true,
    calls: '없음 — DB 에 한 번 물어본다',
    spec: 'NF-AV-001 · API 설계 4-9',
    responses: {
      200: {
        description: '상태',
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
