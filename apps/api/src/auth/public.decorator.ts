import { SetMetadata } from '@nestjs/common';

/**
 * 인증 없이 열어 두는 라우트에 붙인다 — 인증 화면(회원가입 · 로그인)과 `/health` 뿐이다.
 * 그 외 모든 API 는 가드가 막는다 (PM-AC-003 · PM-AC-004).
 */
export const IS_PUBLIC = 'auth:isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
