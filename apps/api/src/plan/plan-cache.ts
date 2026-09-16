import { PLAN_LIST_CACHE_TTL_MS } from '@tourlint/shared';

/**
 * 기획 조회의 **메모리 캐시** (FR-PL-010 · 018 · DB 명세서 6-4).
 *
 * 같은 지역 · 같은 중분류를 화면에서 여러 번 열어도 공사를 다시 부르지 않게 한다. 10분이 지나면
 * 버린다 — 그 이상 붙잡고 있으면 공사가 바꾼 것을 한참 뒤에야 본다.
 *
 * ⚠️ **DB · 로그에 남기지 않는다.** 여기 담기는 것은 목록 응답(제목 · 주소 포함)이라 저장 경계
 *    밖이다. 프로세스가 죽으면 사라져도 되고, 그때는 다시 부르면 된다.
 */
export class PlanCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number = PLAN_LIST_CACHE_TTL_MS,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** 캐시에 있으면 그것, 없으면 불러서 담는다. **부르다 실패하면 담지 않는다** */
  async getOrLoad<T>(key: string, load: () => Promise<T>): Promise<T> {
    const found = this.entries.get(key);
    if (found !== undefined && found.expiresAt > this.clock()) return found.value as T;
    const value = await load();
    this.entries.set(key, { value, expiresAt: this.clock() + this.ttlMs });
    return value;
  }

  /** 담긴 것만 본다. 없으면 `undefined` — 「아직 안 불렀다」와 「0건」을 가른다 */
  peek<T>(key: string): T | undefined {
    const found = this.entries.get(key);
    return found !== undefined && found.expiresAt > this.clock() ? (found.value as T) : undefined;
  }

  clear(): void {
    this.entries.clear();
  }
}
