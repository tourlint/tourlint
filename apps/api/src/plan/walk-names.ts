import { isKtoError, type KtoClient } from '../external/kto';
import { PlanCache } from './plan-cache';
import type { PlanBudget } from './plan.service';

/**
 * 넣은 걷기 길의 **표시 이름** (D9 · DR-MD-005 · EX-PL-011).
 *
 * 일정 항목에는 `walk_id` 만 저장한다 — 코스 이름은 공사 원문이라 담지 않는다. 화면 · 리포트가
 * 이름을 보일 때 여기서 찾고, **못 찾으면 없는 대로 둔다**(화면은 "걷기 길"로 적는다).
 *
 * 두루누비 코스 목록은 지역 조건이 없어 전국이 1콜에 온다. 10분 메모리 캐시라 여러 줄을 한 번에
 * 물어도 조회는 한 번이다.
 */
export class WalkNameResolver {
  private readonly kto: () => KtoClient;
  private readonly budget: PlanBudget;
  private readonly cache: PlanCache;

  constructor(options: { kto: () => KtoClient; budget: PlanBudget; cache?: PlanCache }) {
    this.kto = options.kto;
    this.budget = options.budget;
    this.cache = options.cache ?? new PlanCache();
  }

  /** 찾은 것만 담아 돌려준다. 목록을 못 받으면 빈 지도다 */
  async resolve(walkIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const wanted = new Set(walkIds.filter((id) => id !== ''));
    if (wanted.size === 0) return new Map();

    const courses = await this.cache.getOrLoad('walks:all', async () => {
      try {
        const decision = await this.budget('DURUNUBI');
        if (!decision.allowed) return null;
        return (await this.kto().courseList()).items;
      } catch (e) {
        if (!isKtoError(e)) throw e;
        return null;
      }
    });

    const out = new Map<string, string>();
    for (const course of courses ?? []) {
      const id = String(course.crsIdx ?? '');
      const name = String(course.crsKorNm ?? '').trim();
      if (wanted.has(id) && name !== '') out.set(id, name);
    }
    return out;
  }
}
