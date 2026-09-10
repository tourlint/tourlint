import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import type { Pool } from 'pg';
import { PlaceNameResolver } from './audit/place-name';
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
import { ContentController } from './content/content.controller';
import { ContentService } from './content/content.service';
import { CatalogService } from './catalog/catalog.service';
import { DemoController } from './demo/demo.controller';
import { evaluateBudget } from './external/budget-guard';
import { createKtoClient, type KtoClient } from './external/kto';
import type { ContentTypeId } from '@tourlint/shared';
import { DB_POOL, getPool } from './persistence/db';
import { PatchApplicationRepository } from './persistence/patch-application.repository';
import { PgApiCallLogger } from './persistence/api-call-log.repository';
import { AuditResultRepository } from './persistence/audit-result.repository';
import { BatchStateRepository } from './persistence/batch-state.repository';
import { NotificationRepository } from './persistence/notification.repository';
import { HealthController } from './health/health.controller';
import { PlaceMatchController } from './match/place-match.controller';
import { PlaceMatchRepository } from './match/place-match.repository';
import { PlaceMatchService } from './match/place-match.service';
import { ProductController } from './product/product.controller';
import { ItemController } from './product/item.controller';
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
import { NlService } from './upload/nl.service';
import { UploadController } from './upload/upload.controller';
import { RootController } from './root/root.controller';
import { UsageController } from './usage/usage.controller';
import { UsageService } from './usage/usage.service';
import { SettingsController } from './settings/settings.controller';
import { SettingsService } from './settings/settings.service';
import { SettingsRepository } from './settings/settings.repository';
import { SettingsTablesController } from './settings/settings-tables.controller';
import { SettingsTablesService } from './settings/settings-tables.service';
import { SettingsTablesRepository } from './settings/settings-tables.repository';

/**
 * 목업은 남아 있지 않다. 마지막 두 라우트(출시 승인 · 항목 목록)를 실엔진으로 옮기면서
 * `src/mock` 을 통째로 지웠다 — 공사 호출을 모의 응답으로 전면 대체한 채 제출하면
 * 심사에서 제외된다 (NF-CO-002 · FR-OP-009).
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
    AuditController, UsageController, DemoController, ProductController, ItemController, PlaceMatchController,
    /*
     * `ContentController` 의 `contents/:contentId` 는 **정적 경로 뒤에 둔다.** 앞에 두면
     * `contents/search` 를 삼켜 검색어가 콘텐츠 번호로 읽힌다 (이슈 #341).
     * 순서에만 기대지 않도록 `app-boot` 이 가려짐을 검사한다.
     */
    ContentController,
    ReportController, NotificationController, RadarController, SettingsController, SettingsTablesController,
  ],
  providers: [
    { provide: DB_POOL, useFactory: () => getPool() },
    { provide: APP_GUARD, useClass: AuthGuard },
    {
      // 자연어 붙여넣기 정형화 (F01 · FR-IN-003). 저장하지 않는다 (UI-S2-010)
      provide: NlService,
      useFactory: (pool: Pool) => new NlService(new PgApiCallLogger(pool)),
      inject: [DB_POOL],
    },
    {
      // 관광지 1건 실시간 조회 (5-12 근거 펼침). 저장하지 않는다 (DR-PR-004)
      provide: ContentService,
      useFactory: (pool: Pool) => new ContentService(() => createKtoClient(new PgApiCallLogger(pool))),
      inject: [DB_POOL],
    },
    {
      // 관리자 설정 (F16). 계정 설정 조회·저장 + 전역 설정 조회 (PM-DA-005)
      provide: SettingsService,
      useFactory: (pool: Pool) => new SettingsService(new SettingsRepository(pool)),
      inject: [DB_POOL],
    },
    {
      // 계정 기준표 편집 (F16 · 체류시간 · 실내외 매핑)
      provide: SettingsTablesService,
      useFactory: (pool: Pool) => new SettingsTablesService(new SettingsTablesRepository(pool)),
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
      useFactory: (pool: Pool, catalog: CatalogService) => new ProductService(
        new ProductRepository(pool),
        catalog,
        new PatchApplicationRepository(pool),
        // 대체·추가된 항목의 이름은 표시할 때 읽는다 (FR-PA-003 · DR-PR-001)
        new PlaceNameResolver({ kto: () => createKtoClient(new PgApiCallLogger(pool)) }),
      ),
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
