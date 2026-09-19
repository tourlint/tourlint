import type { Endpoint } from '../types';

const ACCOUNT = { email: 'openapi@tourlint.kr', isDemo: true };

export const AUTH: readonly Endpoint[] = [
  {
    route: 'POST /api/v1/auth/signup-code',
    tag: '1. 인증',
    summary: '회원가입 인증코드 받기',
    description: [
      '가입할 이메일로 6자리 인증코드를 보낸다. **계정도 세션도 만들지 않는다.** 받은 `verificationId` 와 메일의 코드로 `POST /auth/signup` 을 부른다.',
      '',
      '- 이미 가입된 이메일이어도 같은 모양으로 답한다 — 가입 여부를 알리지 않는다.',
      '- 코드는 10분 동안 유효하고 5번 틀리면 새 코드가 필요하다. 코드 원문은 응답에도 로그에도 없다.',
      '- 같은 이메일은 60초에 한 번, 한 시간에 5번까지 받을 수 있다.',
      '- 메일 발송이 설정되지 않았거나 실패하면 503 이다. 인증을 건너뛰고 가입시키지 않는다.',
      '- 이메일 형식이 틀리면 400 이다.',
    ].join('\n'),
    screen: '로그인 › 회원가입 › 인증코드 받기',
    public: true,
    calls: '인증메일 1통 (Google Apps Script · Gmail)',
    spec: 'FR-CM-001 · PM-AC-008 · EI-MA · API 설계 4-1',
    body: {
      example: { email: 'new-user@example.com' },
      required: ['email'],
      fields: { email: '가입할 이메일' },
    },
    responses: {
      200: {
        description: '인증메일을 보냈다',
        example: {
          verificationId: '6d0f3c2e-8a51-4c77-9d0e-2b1f5a9c7e41',
          expiresAt: '2026-09-20T01:33:45.000Z',
          resendAfterSeconds: 60,
        },
      },
    },
    errors: [
      { status: 429, reasonCode: 'RATE_LIMIT_EXCEEDED', when: '60초 안에 다시 요청함 — `Retry-After` 헤더에 남은 초', message: '인증코드는 60초 후 다시 받을 수 있습니다.' },
      { status: 429, reasonCode: 'RATE_LIMIT_EXCEEDED', when: '이메일당 시간당 · 서비스 전체 한도 초과', message: '인증메일 요청이 많습니다. 잠시 후 다시 시도해 주세요.' },
    ],
  },
  {
    route: 'POST /api/v1/auth/signup',
    tag: '1. 인증',
    summary: '회원가입',
    description: [
      '이메일 · 비밀번호와 인증코드를 확인하고 계정을 만든다. 성공하면 **곧바로 로그인된 상태**다 — 세션 쿠키를 함께 심는다.',
      '',
      '- 코드 확인 · 코드 소비 · 계정 생성 · 기본 설정 생성이 한 트랜잭션이다. 중간에 실패하면 아무것도 남지 않는다.',
      '- 코드가 틀렸거나 만료 · 사용됨 · 5회 초과면 400 한 가지로 답한다 — 무엇이 틀렸는지 구분해 알려 주지 않는다.',
      '- 비밀번호는 8자 이상 128자 이하. 이미 가입된 이메일은 사유를 밝히지 않고 400 이다.',
    ].join('\n'),
    screen: '로그인 › 회원가입 › 인증하고 가입 완료',
    public: true,
    calls: '없음',
    spec: 'FR-CM-001 · EX-SY-007 · API 설계 4-1',
    body: {
      example: {
        email: 'new-user@example.com',
        password: '8자 이상 비밀번호',
        verificationId: '6d0f3c2e-8a51-4c77-9d0e-2b1f5a9c7e41',
        code: '482913',
      },
      required: ['email', 'password', 'verificationId', 'code'],
      fields: {
        email: '인증코드를 받은 이메일',
        password: '8자 이상 128자 이하',
        verificationId: '`POST /auth/signup-code` 가 준 값',
        code: '메일로 받은 6자리 숫자',
      },
    },
    responses: {
      201: {
        description: '가입 완료. `Set-Cookie: tourlint_session=…` 이 함께 온다',
        example: { email: 'new-user@example.com', isDemo: false },
      },
    },
  },
  {
    route: 'POST /api/v1/auth/login',
    tag: '1. 인증',
    summary: '로그인 — 이 페이지에서 먼저 부르세요',
    description: [
      '이메일 · 비밀번호를 확인하고 세션 쿠키 `tourlint_session`(HttpOnly · SameSite=Lax · 7일)을 심는다. 세션은 서버 DB 에 있고 로그아웃하면 서버에서 지운다.',
      '',
      '**이 문서에서 API 를 불러 보려면 여기부터.** **Try it out** → 제출 서류의 테스트 계정으로 본문을 채우고 **Execute**. ' +
        '`200` 이 오면 쿠키가 브라우저에 저장되어 아래 API 를 그대로 부를 수 있다.',
      '',
      '- 이메일이나 비밀번호가 틀리면 어느 쪽이 틀렸는지 밝히지 않고 401 이다.',
    ].join('\n'),
    screen: '로그인',
    public: true,
    calls: '없음',
    spec: 'FR-CM-002 · EX-SY-004 · NF-SC-002 · API 설계 4-1',
    body: {
      example: { email: 'openapi@tourlint.kr', password: '제출 서류의 테스트 계정 비밀번호' },
      required: ['email', 'password'],
      fields: { email: '가입한 이메일. 심사용 테스트 계정은 openapi@tourlint.kr', password: '비밀번호' },
    },
    responses: {
      200: { description: '로그인됨. `Set-Cookie: tourlint_session=…` 이 함께 온다', example: ACCOUNT },
    },
    errors: [
      { status: 401, reasonCode: 'NOT_AUTHENTICATED', when: '이메일 또는 비밀번호가 틀림', message: '이메일 또는 비밀번호가 올바르지 않습니다.' },
    ],
  },
  {
    route: 'POST /api/v1/auth/logout',
    tag: '1. 인증',
    summary: '로그아웃',
    description:
      '서버의 세션 행을 지우고 쿠키를 없앤다. 이미 끝난 세션으로 불러도 문제없이 `204` 다 — 그래서 로그인 없이도 부를 수 있다.',
    screen: '상단 계정 메뉴 › 로그아웃',
    public: true,
    calls: '없음',
    spec: 'FR-CM-002 · PM-AC-005 · API 설계 4-1',
    responses: { 204: { description: '로그아웃됨' } },
  },
  {
    route: 'GET /api/v1/auth/me',
    tag: '1. 인증',
    summary: '지금 로그인한 계정',
    description:
      '세션 쿠키로 확인한 계정의 이메일과 심사용 계정 여부(`isDemo`)를 돌려준다. 로그인이 풀렸으면 401 — 화면은 이 응답으로 로그인 화면으로 보낼지 정한다.',
    screen: '모든 화면 — 상단 계정 표시',
    calls: '없음',
    spec: 'PM-AC-004 · PM-TA-006 · API 설계 4-1',
    responses: { 200: { description: '로그인한 계정', example: ACCOUNT } },
  },
];
