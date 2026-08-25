import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AuthGuard } from './auth/auth.guard';
import { DB_POOL, getPool } from './persistence/db';
import { HealthController } from './health/health.controller';
import { MockController } from './mock/mock.controller';

/**
 * `MockController` 는 아직 남은 42개 라우트를 담당한다. 실엔진으로 교체된 라우트는
 * 즉시 제거한다 — 공사 호출을 모의 응답으로 전면 대체한 채 제출하면 심사에서
 * 제외된다 (NF-CO-002 · FR-OP-009).
 *
 * DB 풀은 `DB_POOL` **심볼 토큰**으로 주입한다. `pg` 의 `Pool` 클래스를 토큰으로 쓰면
 * 타입 전용 import 한 곳에서 런타임 값이 지워져 주입이 깨진다.
 *
 * `AuthGuard` 는 `APP_GUARD` 로 전역 등록한다. `@Public()` 라우트(인증 · health)만 열고
 * 나머지 API 는 전부 세션을 요구한다 (PM-AC-003 · PM-AC-004).
 */
@Module({
  controllers: [HealthController, AuthController, AuditController, MockController],
  providers: [
    { provide: DB_POOL, useFactory: () => getPool() },
    { provide: APP_GUARD, useClass: AuthGuard },
    AuthService,
    AuditService,
  ],
})
export class AppModule {}
