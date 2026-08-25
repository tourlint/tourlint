import { Module } from '@nestjs/common';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { DB_POOL, getPool } from './persistence/db';
import { HealthController } from './health/health.controller';
import { MockController } from './mock/mock.controller';
import { RootController } from './root/root.controller';
import { UsageController } from './usage/usage.controller';
import { UsageService } from './usage/usage.service';

/**
 * `MockController` 는 아직 교체되지 않은 라우트를 담당한다. 실엔진으로 교체된 라우트는
 * 즉시 제거한다 — 공사 호출을 모의 응답으로 전면 대체한 채 제출하면 심사에서
 * 제외된다 (NF-CO-002 · FR-OP-009).
 *
 * DB 풀은 `DB_POOL` **심볼 토큰**으로 주입한다. `pg` 의 `Pool` 클래스를 토큰으로 쓰면
 * 타입 전용 import 한 곳에서 런타임 값이 지워져 주입이 깨진다.
 */
@Module({
  controllers: [RootController, HealthController, AuditController, UsageController, MockController],
  providers: [
    { provide: DB_POOL, useFactory: () => getPool() },
    AuditService,
    UsageService,
  ],
})
export class AppModule {}
