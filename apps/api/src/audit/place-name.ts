import { isKtoError, type KtoClient } from '../external/kto';

/**
 * 대체 관광지 **표시 이름** (DR-PR-001 · FR-PA-003).
 *
 * 수정안은 명칭을 담지 않는다 — 대체 후보의 이름은 사용자가 입력한 것이 아니라 공사 원문이라
 * 저장하면 규정 위반이다 (`patch-types` 주석). 대신 **표시할 때 조회한다.**
 *
 * 그 조회가 없어서 화면이 「가까운 다른 관광지로 대체」로만 떴고, 반영해도 `place_label` 이
 * 그대로라 전후 비교가 같아 보였다. 여기가 그 빈 자리다.
 *
 * ## 저장하지 않는다
 *
 * 결과를 DB 에도 로그에도 남기지 않는다. 프로세스 메모리에 **짧게만** 들고 있다가 버린다 —
 * 같은 화면을 몇 번 열 때마다 같은 콘텐츠를 다시 부르지 않으려는 것뿐이다.
 */

/** 캐시 수명. 짧게 둔다 — 오래 들고 있으면 그건 저장이다 */
export const NAME_TTL_MS = 10 * 60_000;
/** 캐시 상한. 넘으면 오래된 것부터 버린다 */
export const NAME_CACHE_MAX = 500;

interface Entry {
  readonly name: string;
  readonly at: number;
}

export interface PlaceNameOptions {
  readonly kto: KtoClient;
  readonly clock?: () => number;
}

export class PlaceNameResolver {
  private readonly cache = new Map<string, Entry>();
  private readonly kto: KtoClient;
  private readonly clock: () => number;

  constructor(options: PlaceNameOptions) {
    this.kto = options.kto;
    this.clock = options.clock ?? ((): number => Date.now());
  }

  /**
   * 콘텐츠 이름을 모아 온다. **못 읽은 것은 넣지 않는다** — 지어낸 이름을 보여줄 수 없다.
   *
   * 한 건이 실패해도 나머지는 준다. 이름을 못 얻는 것은 표시 문제일 뿐 판정 문제가 아니다.
   */
  async resolve(contentIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    const now = this.clock();
    const wanted = [...new Set(contentIds.filter((id) => id !== ''))];

    const misses: string[] = [];
    for (const id of wanted) {
      const hit = this.cache.get(id);
      if (hit !== undefined && now - hit.at < NAME_TTL_MS) out.set(id, hit.name);
      else misses.push(id);
    }

    for (const id of misses) {
      try {
        const detail = await this.kto.detailCommon(id);
        const title = String(detail.title ?? '').trim();
        if (title === '') continue;
        out.set(id, title);
        this.remember(id, title, now);
      } catch (e) {
        // 못 읽으면 그 하나만 이름 없이 간다. 화면은 유형·거리로 표시한다
        if (!isKtoError(e)) throw e;
      }
    }
    return out;
  }

  private remember(id: string, name: string, at: number): void {
    if (this.cache.size >= NAME_CACHE_MAX) {
      // 삽입 순서가 곧 오래된 순이다 (Map 의 성질)
      const oldest = this.cache.keys().next();
      if (!(oldest.done ?? false)) this.cache.delete(oldest.value as string);
    }
    this.cache.set(id, { name, at });
  }
}
