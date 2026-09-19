import type { Endpoint } from '../types';

const ACCOUNT = { email: 'openapi@tourlint.kr', isDemo: true };

export const AUTH: readonly Endpoint[] = [
  {
    route: 'POST /api/v1/auth/signup-code',
    tag: '인증',
    summary: '회원가입 인증코드 받기',
    description: '가입할 이메일로 6자리 인증코드를 보냅니다. 코드는 10분 동안 유효합니다.',
    public: true,
    body: {
      example: { email: 'new-user@example.com' },
      required: ['email'],
      fields: { email: '가입할 이메일' },
    },
    responses: {
      200: {
        description: '성공',
        example: {
          verificationId: '6d0f3c2e-8a51-4c77-9d0e-2b1f5a9c7e41',
          expiresAt: '2026-09-20T01:33:45.000Z',
          resendAfterSeconds: 60,
        },
      },
    },
    errors: [
      { status: 429, reasonCode: 'RATE_LIMIT_EXCEEDED', when: '60초 안에 다시 요청함', message: '인증코드는 60초 후 다시 받을 수 있습니다.' },
      { status: 429, reasonCode: 'RATE_LIMIT_EXCEEDED', when: '이메일당 시간당 · 서비스 전체 한도 초과', message: '인증메일 요청이 많습니다. 잠시 후 다시 시도해 주세요.' },
    ],
  },
  {
    route: 'POST /api/v1/auth/signup',
    tag: '인증',
    summary: '회원가입',
    description: '이메일로 받은 인증코드를 확인하고 계정을 만듭니다. 가입하면 바로 로그인됩니다.',
    public: true,
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
        password: '비밀번호(8 ~ 128자)',
        verificationId: '`POST /api/v1/auth/signup-code` 응답의 값',
        code: '메일로 받은 6자리 숫자',
      },
    },
    responses: {
      201: {
        description: '성공',
        example: { email: 'new-user@example.com', isDemo: false },
      },
    },
  },
  {
    route: 'POST /api/v1/auth/login',
    tag: '인증',
    summary: '로그인',
    description: '이메일과 비밀번호로 로그인합니다. 성공하면 세션 쿠키가 발급되고, 이후 요청은 이 쿠키로 계정을 확인합니다.',
    public: true,
    body: {
      example: { email: 'openapi@tourlint.kr', password: '제출 서류의 테스트 계정 비밀번호' },
      required: ['email', 'password'],
      fields: { email: '가입한 이메일', password: '비밀번호' },
    },
    responses: {
      200: { description: '성공', example: ACCOUNT },
    },
    errors: [
      { status: 401, reasonCode: 'NOT_AUTHENTICATED', when: '이메일 또는 비밀번호가 틀림', message: '이메일 또는 비밀번호가 올바르지 않습니다.' },
    ],
  },
  {
    route: 'POST /api/v1/auth/logout',
    tag: '인증',
    summary: '로그아웃',
    description:
      '로그인을 끝내고 세션 쿠키를 지웁니다.',
    public: true,
    responses: { 204: { description: '성공 (본문 없음)' } },
  },
  {
    route: 'GET /api/v1/auth/me',
    tag: '인증',
    summary: '내 계정 정보',
    description:
      '로그인한 계정의 이메일을 돌려줍니다.',
    responses: { 200: { description: '성공', example: ACCOUNT } },
  },
];
