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
  /**
   * **클라이언트를 만드는 함수를 받는다.** 인스턴스를 받으면 이 리졸버를 조립하는 자리에서
   * `createKtoClient` 가 즉시 돌고, 인증키가 비어 있으면 거기서 던져 앱 전체가 못 뜬다.
   * `CatalogService` · `PlaceMatchService` 가 같은 이유로 팩토리를 받는다.
   */
  readonly kto: () => KtoClient;
  readonly clock?: () => number;
}

export class PlaceNameResolver {
  private readonly cache = new Map<string, Entry>();
  private readonly makeKto: () => KtoClient;
  private readonly clock: () => number;
  /** 첫 조회 때 만든다. 이후에는 같은 것을 쓴다 */
  private client: KtoClient | null = null;

  constructor(options: PlaceNameOptions) {
    this.makeKto = options.kto;
    this.clock = options.clock ?? ((): number => Date.now());
  }

  private get kto(): KtoClient {
    this.client ??= this.makeKto();
    return this.client;
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

/** 이름을 얹을 대상이 되는 항목의 최소 모양. `ItineraryItemRow` 가 이걸 만족한다 */
export interface NameableItem {
  readonly id: number;
  readonly ktoContentId: string | null;
  readonly placeLabel: string;
}

/**
 * 대체된 항목의 이름을 **응답에만** 얹는다 (DR-PR-001).
 *
 * `REPLACE_CONTENT` 는 자리를 두고 콘텐츠만 바꾸며 `placeLabel` 은 건드리지 않는다 —
 * 대체 후보의 명칭이 공사 원문이라 저장할 수 없기 때문이다. 그래서 전후 비교가 **같아
 * 보였다.** 여기서 표시용으로만 덮는다. 저장된 `place_label` 은 그대로다.
 *
 * 콘텐츠가 안 바뀐 항목은 손대지 않는다. 이름을 못 읽었으면 원래 이름을 둔다 — 지어내지 않는다.
 */
export function applyNames<T extends NameableItem>(
  before: readonly NameableItem[],
  after: readonly T[],
  names: ReadonlyMap<string, string>,
): readonly T[] {
  const was = new Map(before.map((i) => [i.id, i.ktoContentId]));
  return after.map((item) => {
    if (item.ktoContentId === null || was.get(item.id) === item.ktoContentId) return item;
    const name = names.get(item.ktoContentId);
    return name === undefined ? item : { ...item, placeLabel: name };
  });
}

/** 콘텐츠가 바뀐 항목들의 `ktoContentId`. 이름을 물어볼 대상이다 */
export function replacedContentIds(
  before: readonly NameableItem[],
  after: readonly NameableItem[],
): readonly string[] {
  const was = new Map(before.map((i) => [i.id, i.ktoContentId]));
  return after
    .filter((i) => i.ktoContentId !== null && was.get(i.id) !== i.ktoContentId)
    .map((i) => i.ktoContentId as string);
}

/**
 * 이름을 물어볼 콘텐츠 id (FR-PA-003).
 *
 * 대체(`REPLACE_CONTENT`)와 추가(`INSERT_ITEM`) 둘 다다. 추가 수정안도 무엇을 넣는지가
 * 전부라, 이름이 없으면 후보 둘이 화면에 똑같이 보인다.
 */
export function collectPatchContentIds(
  run: { findings: readonly { patches: readonly { type: string; payload: unknown }[] }[] },
): readonly string[] {
  return run.findings.flatMap((f) => f.patches.flatMap((p) => {
    const payload = p.payload as { ktoContentId?: unknown; content?: { ktoContentId?: unknown } };
    const id = p.type === 'REPLACE_CONTENT' ? String(payload.ktoContentId ?? '')
      : p.type === 'INSERT_ITEM' ? String(payload.content?.ktoContentId ?? '')
        : '';
    return id === '' ? [] : [id];
  }));
}
