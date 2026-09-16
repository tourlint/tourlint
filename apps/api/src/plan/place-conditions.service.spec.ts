import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryApiCallLogger } from '../external/api-call-log';
import type { BudgetDecision } from '../external/budget-guard';
import { FixtureKtoTransport, KtoClient } from '../external/kto';
import { PlaceConditionService } from './place-conditions.service';

const FIXTURES = join(__dirname, '../../../../fixtures/kto');
const allowed: BudgetDecision = { allowed: true, ratio: 0.1, reasonCode: null, warn: false, remaining: 720 };
const blocked: BudgetDecision = { allowed: false, ratio: 1, reasonCode: 'BUDGET_EXHAUSTED', warn: true, remaining: 0 };

function conditions(budget: Partial<Record<string, BudgetDecision>> = {}): { service: PlaceConditionService; calls: () => Record<string, number> } {
  const transport = new FixtureKtoTransport(FIXTURES);
  return {
    service: new PlaceConditionService({
      kto: () => new KtoClient({ transport, logger: new InMemoryApiCallLogger(), sleep: async () => undefined }),
      budget: async (s) => budget[s] ?? allowed,
    }),
    calls: () => Object.fromEntries(transport.replayCounts),
  };
}

describe('카드 펼침의 무장애 · 반려동물 축 (FR-PL-012 · EI-KT-022 · 023)', () => {
  it('🔴 요청한 축만 부른다 — 펼치지 않은 축은 조회하지 않는다', async () => {
    const { service, calls } = conditions();
    const found = await service.of('129784', { accessible: true, pet: false });
    expect(found.accessible).toMatchObject({ wheelchair: expect.anything() });
    expect(found.pet).toBeNull();
    expect(calls().detailPetTour2).toBeUndefined();
  });

  it('조건 값만 돌려주고 contentid 는 빼고 준다', async () => {
    const { service } = conditions();
    const found = await service.of('129784', { accessible: true, pet: false });
    expect(found.accessible).not.toHaveProperty('contentid');
  });

  it('🔴 그 서비스가 막히거나 실패하면 그 축만 null 이다 (EX-PL-004)', async () => {
    const { service } = conditions({ WITH: blocked });
    expect((await service.of('129784', { accessible: true, pet: false })).accessible).toBeNull();

    // 픽스처에 없는 콘텐츠 — 조회 실패도 그 축만 null 이다
    const other = conditions();
    expect((await other.service.of('99999999', { accessible: true, pet: false })).accessible).toBeNull();
  });

  it('같은 콘텐츠를 다시 펼쳐도 다시 부르지 않는다', async () => {
    const { service, calls } = conditions();
    await service.of('129784', { accessible: true, pet: false });
    await service.of('129784', { accessible: true, pet: false });
    expect(calls().detailWithTour2).toBe(1);
  });
});
