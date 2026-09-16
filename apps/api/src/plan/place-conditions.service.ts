import { isKtoError, type KtoClient } from '../external/kto';
import { PlanCache } from './plan-cache';
import type { PlanBudget } from './plan.service';

/**
 * 카드를 펼칠 때의 무장애 · 반려동물 동반 조건 (FR-PL-012 · EI-KT-022 · 023).
 *
 * 목록의 집합은 「해당 여부」만 알려 준다 — 어떤 시설이 있는지는 **펼칠 때 상세 1콜**로 본다.
 * 미리 부르지 않는다: 목록 한 쪽이 20곳이면 40콜이 된다.
 *
 * 서비스가 막히거나 실패하면 그 축만 `null` 이다. 카드의 나머지는 그대로 보인다 (EX-PL-004).
 */

export interface PlaceConditions {
  readonly accessible: Record<string, unknown> | null;
  readonly pet: Record<string, unknown> | null;
}

export interface ConditionWant {
  readonly accessible: boolean;
  readonly pet: boolean;
}

export class PlaceConditionService {
  private readonly kto: () => KtoClient;
  private readonly budget: PlanBudget;
  private readonly cache: PlanCache;

  constructor(options: { kto: () => KtoClient; budget: PlanBudget; cache?: PlanCache }) {
    this.kto = options.kto;
    this.budget = options.budget;
    this.cache = options.cache ?? new PlanCache();
  }

  async of(contentId: string, want: ConditionWant): Promise<PlaceConditions> {
    const [accessible, pet] = await Promise.all([
      want.accessible ? this.detail(contentId, 'WITH') : Promise.resolve(null),
      want.pet ? this.detail(contentId, 'PET') : Promise.resolve(null),
    ]);
    return { accessible, pet };
  }

  private async detail(contentId: string, service: 'WITH' | 'PET'): Promise<Record<string, unknown> | null> {
    return this.cache.getOrLoad(`${service}:detail:${contentId}`, async () => {
      try {
        const decision = await this.budget(service);
        if (!decision.allowed) return null;
        const item = service === 'WITH'
          ? await this.kto().detailWithTour(contentId)
          : await this.kto().detailPetTour(contentId);
        // `contentid` 는 호출자가 이미 안다. 조건 값만 돌려준다
        const { contentid: _contentId, ...fields } = item;
        return fields;
      } catch (e) {
        if (!isKtoError(e)) throw e;
        return null;
      }
    });
  }
}
