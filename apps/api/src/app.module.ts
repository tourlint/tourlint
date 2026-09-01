import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import type { Pool } from 'pg';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AuthGuard } from './auth/auth.guard';
import { SignalBatchJob } from './batch/signal-batch.job';
import { SignalRunner } from './batch/signal-runner';
import { SyncBatchJob } from './batch/sync-batch.job';
import { SyncBatchScheduler } from './batch/sync-batch.scheduler';
import { CatalogController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { DemoController } from './demo/demo.controller';
import { evaluateBudget } from './external/budget-guard';
import { createKtoClient, type KtoClient } from './external/kto';
import type { ContentTypeId } from '@tourlint/shared';
import { DB_POOL, getPool } from './persistence/db';
import { PgApiCallLogger } from './persistence/api-call-log.repository';
import { AuditResultRepository } from './persistence/audit-result.repository';
import { BatchStateRepository } from './persistence/batch-state.repository';
import { NotificationRepository } from './persistence/notification.repository';
import { HealthController } from './health/health.controller';
import { PlaceMatchController } from './match/place-match.controller';
import { PlaceMatchRepository } from './match/place-match.repository';
import { PlaceMatchService } from './match/place-match.service';
import { ProductController } from './product/product.controller';
import { ProductRepository } from './product/product.repository';
import { ProductService } from './product/product.service';
import { DemandSignalRepository } from './persistence/demand-signal.repository';
import { NotificationController } from './radar/notification.controller';
import { NotificationService } from './radar/notification.service';
import { RadarController } from './radar/radar.controller';
import { RadarRepository } from './radar/radar.repository';
import { RadarService } from './radar/radar.service';
import { ReportController } from './report/report.controller';
import { ReportService } from './report/report.service';
import { UploadController } from './upload/upload.controller';
import { MockController } from './mock/mock.controller';
import { RootController } from './root/root.controller';
import { UsageController } from './usage/usage.controller';
import { UsageService } from './usage/usage.service';
import { SettingsController } from './settings/settings.controller';
import { SettingsService } from './settings/settings.service';
import { SettingsRepository } from './settings/settings.repository';

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
    AuditController, UsageController, DemoController, ProductController, PlaceMatchController,
    ReportController, NotificationController, RadarController, SettingsController,
    MockController,
  ],
  providers: [
    { provide: DB_POOL, useFactory: () => getPool() },
    { provide: APP_GUARD, useClass: AuthGuard },
    {
      // 관리자 설정 (F16). 계정 설정 조회·저장 + 전역 설정 조회 (PM-DA-005)
      provide: SettingsService,
      useFactory: (pool: Pool) => new SettingsService(new SettingsRepository(pool)),
      inject: [DB_POOL],
    },
    {
      // 지역·분류 코드 프록시. KTO_MODE=fixture 면 fixtures/kto 리플레이 (예산 0)
      provide: CatalogService,
      useFactory: (pool: Pool) => new CatalogService(() => createKtoClient(new PgApiCallLogger(pool))),
      inject: [DB_POOL],
    },
    {
      // 상품 CRUD. 목록의 지역명 조회에 CatalogService 를 재사용한다 (fixture 리플레이라 예산 0)
      provide: ProductService,
      useFactory: (pool: Pool, catalog: CatalogService) => new ProductService(new ProductRepository(pool), catalog),
      inject: [DB_POOL, CatalogService],
    },
    {
      // 관광지 확정(매칭). 검색·상세 프록시에 KTO 클라이언트를 쓴다 (KTO_MODE 에 따라 live/fixture)
      provide: PlaceMatchService,
      useFactory: (pool: Pool) =>
        new PlaceMatchService(new PlaceMatchRepository(pool), () => createKtoClient(new PgApiCallLogger(pool))),
      inject: [DB_POOL],
    },
    {
      /*
       * 경량 동기화 배치 (F12 · FR-MO-010 ~ 016 · 030 ~ 036).
       *
       * `eventPeriod` 만 상세 재호출을 쓴다. 조건 2 의 시군구는 동기화 목록에 이미 있고,
       * 조건 1 은 우리 DB 만 본다 — 행사(15) 건수만큼만 콜이 나간다.
       */
      provide: SyncBatchJob,
      useFactory: (pool: Pool, audit: AuditService) => {
        const logs = new PgApiCallLogger(pool);
        const state = new BatchStateRepository(pool);
        const results = new AuditResultRepository(pool);
        // 인증키가 비면 생성자가 던진다. 부팅이 아니라 첫 조회에서 나야 한다
        let client: KtoClient | null = null;
        const kto = (): KtoClient => (client ??= createKtoClient(logs));
        return new SyncBatchJob({
          kto,
          state,
          notifications: new NotificationRepository(pool),
          // 배치는 80% 에서 먼저 멈춘다. 사용자 "지금 재검수" 는 100% 까지 간다 (FR-OP-003)
          hasBudget: async () => {
            const { dailyQuota } = await state.setting();
            const usedToday = await logs.countToday('KTO', new Date());
            return evaluateBudget({ dailyBudget: dailyQuota, usedToday }, 'BATCH').allowed;
          },
          /*
           * 상세 한 번으로 행사기간(조건 3)과 지문(FR-MO-036)을 둘 다 얻는다. 유형을 함께
           * 넘겨야 유형별 필드가 채워져 온다 (EI-KT).
           */
          fetchDetail: async (contentId: string, contentTypeId: number) =>
            kto().detailIntro(contentId, contentTypeId as ContentTypeId),
          // 직전 지문은 상품 단위다 — 콘텐츠 전역 최신을 쓰면 남이 본 변경을 이미 알린 것으로 넘긴다
          previousFingerprints: (productId: number) => results.previousFingerprints(productId),
          requestAudit: async (productId: number) => {
            await audit.requestAudit(productId, 'BATCH');
          },
        });
      },
      inject: [DB_POOL, AuditService],
    },
    {
      /*
       * T1 · T2 수요 신호 산출 (F14). 조회 시점에 공사를 부르지 않기로 해서
       * 배치가 미리 산출한다 (2026-08-30 결정).
       */
      provide: SignalBatchJob,
      useFactory: (pool: Pool) => {
        const logs = new PgApiCallLogger(pool);
        const state = new BatchStateRepository(pool);
        let client: KtoClient | null = null;
        return new SignalBatchJob({
          runner: new SignalRunner({ kto: () => (client ??= createKtoClient(logs)) }),
          signals: new DemandSignalRepository(pool),
          radar: new RadarRepository(pool),
          hasBudget: async () => {
            const { dailyQuota } = await state.setting();
            const usedToday = await logs.countToday('KTO', new Date());
            return evaluateBudget({ dailyBudget: dailyQuota, usedToday }, 'BATCH').allowed;
          },
        });
      },
      inject: [DB_POOL],
    },
    {
      provide: SyncBatchScheduler,
      useFactory: (job: SyncBatchJob, pool: Pool, signalJob: SignalBatchJob) =>
        new SyncBatchScheduler({ job, state: new BatchStateRepository(pool), signalJob }),
      inject: [SyncBatchJob, DB_POOL, SignalBatchJob],
    },
    AuthService,
    AuditService,
    UsageService,
    // 지역 코드를 이름으로 바꾸는 데 CatalogService 를 쓴다 (fixture 리플레이라 예산 0)
    ReportService,
    NotificationService,
    RadarService,
  ],
})
export class AppModule {}
