import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import type { Pool } from 'pg';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AuthGuard } from './auth/auth.guard';
import { SyncBatchJob } from './batch/sync-batch.job';
import { SyncBatchScheduler } from './batch/sync-batch.scheduler';
import { CatalogController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { evaluateBudget } from './external/budget-guard';
import { createKtoClient } from './external/kto';
import { DB_POOL, getPool } from './persistence/db';
import { PgApiCallLogger } from './persistence/api-call-log.repository';
import { BatchStateRepository } from './persistence/batch-state.repository';
import { NotificationRepository } from './persistence/notification.repository';
import { HealthController } from './health/health.controller';
import { UploadController } from './upload/upload.controller';
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
 *
 * `AuthGuard` 는 `APP_GUARD` 로 전역 등록한다. `@Public()` 라우트(인증 · health)만 열고
 * 나머지 API 는 전부 세션을 요구한다 (PM-AC-003 · PM-AC-004).
 *
 * `ScheduleModule` 은 경량 배치 하나를 위해 켠다 (FR-MO-010). `SyncBatchScheduler` 가
 * 매분 깨어나 `system_setting.batch_time` 을 지났는지 본다.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [
    RootController, HealthController,
    AuthController, CatalogController, UploadController,
    AuditController, UsageController,
    MockController,
  ],
  providers: [
    { provide: DB_POOL, useFactory: () => getPool() },
    { provide: APP_GUARD, useClass: AuthGuard },
    {
      // 지역·분류 코드 프록시. KTO_MODE=fixture 면 fixtures/kto 리플레이 (예산 0)
      provide: CatalogService,
      useFactory: (pool: Pool) => new CatalogService(() => createKtoClient(new PgApiCallLogger(pool))),
      inject: [DB_POOL],
    },
    {
      /*
       * 경량 동기화 배치 (F12 · FR-MO-010 ~ 016 · 030 ~ 036).
       *
       * `enrich` 를 아직 안 넘긴다 — 조건 1(일정에 포함)만 판정되고 2 · 3 은 물러난다.
       * 시군구와 행사기간은 상세 재호출로만 오는데, 그 호출의 예산 설계가 따로 필요하다.
       */
      provide: SyncBatchJob,
      useFactory: (pool: Pool, audit: AuditService) => {
        const logs = new PgApiCallLogger(pool);
        const state = new BatchStateRepository(pool);
        return new SyncBatchJob({
          kto: createKtoClient(logs),
          state,
          notifications: new NotificationRepository(pool),
          // 배치는 80% 에서 먼저 멈춘다. 사용자 "지금 재검수" 는 100% 까지 간다 (FR-OP-003)
          hasBudget: async () => {
            const { dailyQuota } = await state.setting();
            const usedToday = await logs.countToday('KTO', new Date());
            return evaluateBudget({ dailyBudget: dailyQuota, usedToday }, 'BATCH').allowed;
          },
          requestAudit: async (productId: number) => {
            await audit.requestAudit(productId, 'BATCH');
          },
        });
      },
      inject: [DB_POOL, AuditService],
    },
    {
      provide: SyncBatchScheduler,
      useFactory: (job: SyncBatchJob, pool: Pool) =>
        new SyncBatchScheduler({ job, state: new BatchStateRepository(pool) }),
      inject: [SyncBatchJob, DB_POOL],
    },
    AuthService,
    AuditService,
    UsageService,
  ],
})
export class AppModule {}
