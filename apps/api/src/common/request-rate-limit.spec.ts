import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AuditController } from '../audit/audit.controller';
import type { AuditService } from '../audit/audit.service';
import type { SessionAccount } from '../auth/session.repository';
import { ProductController } from '../product/product.controller';
import type { ProductService } from '../product/product.service';
import { ReportController } from '../report/report.controller';
import type { ReportService } from '../report/report.service';
import { RateLimitException } from './domain.exception';
import { REQUESTS_PER_MINUTE, RequestRateLimiter } from './request-rate-limit';

const user: SessionAccount = { accountId: 1, email: 'planner@t.test', isDemo: false };
const other: SessionAccount = { accountId: 3, email: 'other@t.test', isDemo: false };
/** 공개 테스트 계정 — 심사위원 여럿이 같이 쓴다 */
const demo: SessionAccount = { accountId: 2, email: 'openapi@tourlint.kr', isDemo: true };

/** 시계를 손으로 돌리는 리미터 */
function clocked(): { limiter: RequestRateLimiter; advance: (ms: number) => void } {
  let now = 1_000_000;
  return { limiter: new RequestRateLimiter(() => now), advance: (ms) => { now += ms; } };
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (e) {
    return e;
  }
  return null;
}

describe('검수 요청 · 리포트 생성 분당 상한 (NF-SC-010 · EX-SY-008 · API 3-4)', () => {
  it(`🔴 계정당 1분에 ${String(REQUESTS_PER_MINUTE)}번까지 받고, 넘으면 429 와 다시 되는 때(초)를 준다`, () => {
    const { limiter, advance } = clocked();
    for (let i = 0; i < REQUESTS_PER_MINUTE; i++) {
      limiter.take(user, 'AUDIT');
      advance(1000);
    }

    const e = thrown(() => limiter.take(user, 'AUDIT'));
    expect(e).toBeInstanceOf(RateLimitException);
    expect((e as RateLimitException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    // 첫 요청이 창을 벗어나는 때 — 5초가 지났으니 55초 뒤
    expect(e).toMatchObject({ reasonCode: 'RATE_LIMIT_EXCEEDED', retryAfterSeconds: 55 });
    expect((e as RateLimitException).message).toContain('55초 뒤에');
  });

  it('창은 밀린다 — 첫 요청이 1분을 넘기면 한 번 더 받는다', () => {
    const { limiter, advance } = clocked();
    for (let i = 0; i < REQUESTS_PER_MINUTE; i++) limiter.take(user, 'AUDIT');
    advance(60_000);
    expect(thrown(() => limiter.take(user, 'AUDIT'))).toBeNull();
  });

  it('🔴 공개 테스트 계정은 세지 않는다 — 같이 쓰는 심사위원이 남의 클릭으로 막히지 않는다 (#799 과 같은 기준)', () => {
    const { limiter } = clocked();
    for (let i = 0; i < REQUESTS_PER_MINUTE * 3; i++) {
      expect(thrown(() => limiter.take(demo, 'AUDIT')), `${String(i + 1)}번째`).toBeNull();
    }
  });

  it('계정마다 따로 세고, 리포트는 검수와 따로 센다', () => {
    const { limiter } = clocked();
    for (let i = 0; i < REQUESTS_PER_MINUTE; i++) limiter.take(user, 'AUDIT');

    expect(thrown(() => limiter.take(other, 'AUDIT'))).toBeNull();
    expect(thrown(() => limiter.take(user, 'REPORT'))).toBeNull();
    expect(thrown(() => limiter.take(user, 'AUDIT'))).toBeInstanceOf(RateLimitException);
  });
});

describe('세 경로가 상한을 지난다', () => {
  const job = {
    id: 42, productId: 7, status: 'QUEUED', triggerType: 'MANUAL', progressDone: 0, progressTotal: 0,
    auditRunId: null, errorCode: null, createdAt: new Date('2026-09-26T00:00:00Z'), finishedAt: null,
  };
  const audit = {
    assertOwns: async () => undefined,
    requestAudit: async () => ({ job, created: true }),
  } as unknown as AuditService;
  const products = {
    handoff: async () => ({ productId: 7, plannedAt: '2026-09-26T09:00:00+09:00', jobId: 42, excludedCount: 0 }),
  } as unknown as ProductService;
  const reports = { create: async () => ({ reportId: 'r-1' }) } as unknown as ReportService;

  it('🔴 다시 검수와 검수 시작이 한 창을 같이 쓴다 — 번갈아 눌러 상한을 두 배로 쓰지 못한다', async () => {
    const { limiter } = clocked();
    const auditController = new AuditController(audit, limiter);
    const productController = new ProductController(products, limiter);

    for (let i = 0; i < 3; i++) await auditController.createJob(user, 7, { triggerType: 'MANUAL' });
    for (let i = 0; i < 2; i++) await productController.handoff(user, 7, {});

    await expect(productController.handoff(user, 7, {})).rejects.toMatchObject({ reasonCode: 'RATE_LIMIT_EXCEEDED' });
    await expect(auditController.createJob(user, 7, undefined)).rejects.toMatchObject({ reasonCode: 'RATE_LIMIT_EXCEEDED' });
    // 공개 테스트 계정은 같은 경로로 계속 된다
    await expect(auditController.createJob(demo, 7, undefined)).resolves.toMatchObject({ jobId: 42 });
  });

  it('🔴 리포트 생성도 센다', async () => {
    const { limiter } = clocked();
    const controller = new ReportController(reports, limiter);
    for (let i = 0; i < REQUESTS_PER_MINUTE; i++) await controller.create(user, 111);
    await expect(controller.create(user, 111)).rejects.toMatchObject({ reasonCode: 'RATE_LIMIT_EXCEEDED' });
  });
});
