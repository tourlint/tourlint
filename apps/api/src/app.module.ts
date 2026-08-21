import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { getPool } from './persistence/db';
import { HealthController } from './health/health.controller';
import { MockController } from './mock/mock.controller';

/**
 * `MockController` 는 아직 남은 42개 라우트를 담당한다. 실엔진으로 교체된 라우트는
 * **즉시 제거한다** — 공사 호출을 모의 응답으로 전면 대체한 채 제출하면 심사에서 제외된다
 * (NF-CO-002 · FR-OP-009).
 */
@Module({
  controllers: [HealthController, AuditController, MockController],
  providers: [
    { provide: Pool, useFactory: (): Pool => getPool() },
    AuditService,
  ],
})
export class AppModule {}
