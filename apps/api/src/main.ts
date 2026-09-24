import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AuditService } from './audit/audit.service';
import { configureHttp } from './http-setup';
import { setupOpenApi } from './openapi/setup';
import { getPool } from './persistence/db';
import { bootstrapDemoAccount, demoEmail } from './seed/demo-seed';
import { CatalogService } from './catalog/catalog.service';
import { KtoReachability } from './health/kto-reachability';
import { describeEgress, formatEgressReport } from './health/egress-diagnostics';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // 예외 필터 · 프록시 신뢰. CORS 는 켜지 않는다 (#778)
  configureHttp(app);

  // 심사위원이 직접 여는 API 문서. 설명은 `openapi/catalog` 에 모여 있다 (#601)
  setupOpenApi(app);

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '::');
  // eslint-disable-next-line no-console
  console.log(`TourLint API → http://localhost:${port}  ·  문서 /docs  ·  상태 /health`);

  await ensureDemoAccountOnBoot();
  warmCatalogOnBoot(app.get(CatalogService), app.get(KtoReachability));
  closeAuditsOnShutdown(app.get(AuditService));
}

/**
 * 재배포 · 재시작의 종료 신호 (NF-AV-008 · #772).
 *
 * 이 프로세스가 돌리던 검수를 `FAILED` 로 닫고 끝낸다. 그냥 죽으면 그 행이 `RUNNING` 으로
 * 남아 그 상품의 재검수 · 수정안 확정이 30분 정리 전까지 막힌다. DB 가 늦어도 3초 안에
 * 끝낸다 — 종료를 붙잡지 않는다.
 */
function closeAuditsOnShutdown(audit: AuditService): void {
  process.once('SIGTERM', () => {
    const exit = (): void => process.exit(0);
    setTimeout(exit, 3000).unref();
    void audit.failRunningJobs().catch(() => 0).finally(exit);
  });
}

/**
 * 지역 · 분류 코드를 배경에서 미리 받아 둔다 (#662).
 *
 * 기다리지 않는다 — 부팅을 늦출 일이 아니고, 실패해도 사용자 요청이 다시 시도한다.
 * 닿을 때까지 뒤에서 다시 예열한다 (#700).
 * 로그의 걸린 시간이 운영에서 공사로 나가는 길의 상태를 말해 준다.
 */
function warmCatalogOnBoot(catalog: CatalogService, reach: KtoReachability): void {
  const log = (line: string): void => {
    // eslint-disable-next-line no-console
    console.log(line);
  };
  // 예열이 닿았는지를 /health 에 잇는다. 못 닿은 컨테이너는 배포 검사를 통과하지 못한다 (#700)
  void reach.track(() => catalog.warm(log), log);
  // 이 컨테이너가 바깥으로 어떻게 나가는지 한 줄. 예열과 나란히 돌고 실패해도 아무것도 막지 않는다 (#758)
  void describeEgress().then((report) => { log(formatEgressReport(report)); }, () => undefined);
}

/**
 * 심사용 계정을 부팅 때 보장한다 (PM-TA-001).
 *
 * `listen` 뒤에 부른다 — DB 가 느리거나 막혀도 API 는 이미 응답할 수 있는 상태여야 한다.
 * 실패해도 부팅을 중단하지 않고 한 줄만 남긴다. 로그에 이메일까지만 적고 비밀번호는
 * 절대 남기지 않는다 (NF-SC-008 · DB 명세서 6-4).
 */
async function ensureDemoAccountOnBoot(): Promise<void> {
  try {
    const result = await bootstrapDemoAccount(getPool());
    // eslint-disable-next-line no-console
    console.log(
      result.status === 'skipped'
        ? '심사용 계정 건너뜀 — DEMO_ACCOUNT_PASSWORD 미설정'
        : `심사용 계정 준비 완료 · ${demoEmail()} · 시연 상품 ${result.seeded}건 적재`,
    );
  } catch (err: unknown) {
    // eslint-disable-next-line no-console
    console.error('심사용 계정 준비 실패:', err instanceof Error ? err.message : err);
  }
}

void bootstrap();
