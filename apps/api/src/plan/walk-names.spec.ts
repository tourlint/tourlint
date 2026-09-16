import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryApiCallLogger } from '../external/api-call-log';
import type { BudgetDecision } from '../external/budget-guard';
import { FixtureKtoTransport, KtoClient } from '../external/kto';
import { WalkNameResolver } from './walk-names';

const FIXTURES = join(__dirname, '../../../../fixtures/kto');
const allowed: BudgetDecision = { allowed: true, ratio: 0.1, reasonCode: null, warn: false, remaining: 720 };
const blocked: BudgetDecision = { allowed: false, ratio: 1, reasonCode: 'BUDGET_EXHAUSTED', warn: true, remaining: 0 };

function resolver(decision: BudgetDecision = allowed): { resolver: WalkNameResolver; calls: () => number } {
  const transport = new FixtureKtoTransport(FIXTURES);
  return {
    resolver: new WalkNameResolver({
      kto: () => new KtoClient({ transport, logger: new InMemoryApiCallLogger() }),
      budget: async () => decision,
    }),
    calls: () => transport.replayCounts.get('courseList') ?? 0,
  };
}

describe('WalkNameResolver — 넣은 걷기 길의 이름 (D9 · DR-MD-005)', () => {
  it('식별자로 이름을 찾는다 — 항목에는 이름을 저장하지 않는다', async () => {
    const names = await resolver().resolver.resolve(['T_CRS_MNG0000004222']);
    expect(names.get('T_CRS_MNG0000004222')).toBe('해파랑길 41코스');
  });

  it('🔴 못 찾은 식별자는 없는 대로 둔다 — 화면이 "걷기 길"로 적는다 (EX-PL-011)', async () => {
    const names = await resolver().resolver.resolve(['T_CRS_MNG9999999999']);
    expect(names.size).toBe(0);
  });

  it('여러 줄을 물어도 목록 조회는 한 번이다 — 10분 캐시', async () => {
    const { resolver: r, calls } = resolver();
    await r.resolve(['T_CRS_MNG0000004222']);
    await r.resolve(['T_CRS_MNG0000004219', 'T_CRS_MNG0000004207']);
    expect(calls()).toBe(1);
  });

  it('물어볼 것이 없으면 부르지 않는다', async () => {
    const { resolver: r, calls } = resolver();
    expect((await r.resolve([])).size).toBe(0);
    expect(calls()).toBe(0);
  });

  it('🔴 두루누비 예산이 막히면 이름 없이 둔다 — 화면을 세우지 않는다', async () => {
    const { resolver: r, calls } = resolver(blocked);
    expect((await r.resolve(['T_CRS_MNG0000004222'])).size).toBe(0);
    expect(calls()).toBe(0);
  });
});
