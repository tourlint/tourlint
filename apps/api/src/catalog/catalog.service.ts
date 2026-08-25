import { FixtureMissingError, type KtoClient } from '../external/kto';

/**
 * 지역·분류 코드 조회 (F01 등록 화면의 지역·유형 드롭다운 · UI-S2-004·007).
 *
 * mock 을 대체한 실엔진이다 — 공사 `ldongCode2` · `lclsSystmCode2` 를 KtoClient 로 부른다
 * (개발에서는 fixtures/kto 리플레이라 예산을 쓰지 않는다).
 *
 * 코드 목록은 거의 바뀌지 않으므로 프로세스 메모리에 캐시한다. 요청마다 공사를 부르면
 * 운영에서 화면을 열 때마다 일일 예산(800건)을 갉아먹는다 — 참조 조회는 그럴 이유가 없다.
 */
export interface CodeItem {
  code: string;
  name: string;
}

export class CatalogService {
  private client: KtoClient | null = null;
  private regionsCache: CodeItem[] | null = null;
  private categoriesCache: CodeItem[] | null = null;
  private readonly signguCache = new Map<string, CodeItem[]>();

  /**
   * KtoClient 는 **지연 생성**한다. 부팅 시점에 만들면 KTO 설정(픽스처 경로·인증키)
   * 문제가 앱 전체를 죽인다 — 코드 조회 하나 때문에 health·auth 까지 못 뜨면 안 된다.
   */
  constructor(private readonly ktoFactory: () => KtoClient) {}

  private kto(): KtoClient {
    return (this.client ??= this.ktoFactory());
  }

  /** 시도 목록 (ldongCode2, 인자 없음). 시군구는 파라미터별 조회라 후속으로 붙인다. */
  async regions(): Promise<CodeItem[]> {
    if (this.regionsCache === null) {
      const page = await this.kto().ldongCode();
      this.regionsCache = toCodeItems(page.items);
    }
    return this.regionsCache;
  }

  /**
   * 한 시도의 시군구 목록 (ldongCode2 + lDongRegnCd).
   *
   * 실호출(라이브) 모드에선 모든 시도가 동작한다. fixture 모드에 그 지역 스냅샷이 없으면
   * **빈 목록**으로 답한다 — 시도 목록을 시군구인 척 돌려주지 않는다. 실제 KTO 오류는 올린다.
   */
  async signgus(regnCd: string): Promise<CodeItem[]> {
    const cached = this.signguCache.get(regnCd);
    if (cached !== undefined) return cached;

    let items: CodeItem[];
    try {
      const page = await this.kto().ldongCode(regnCd);
      items = toCodeItems(page.items);
    } catch (e) {
      if (e instanceof FixtureMissingError) items = [];
      else throw e;
    }
    this.signguCache.set(regnCd, items);
    return items;
  }

  /** 분류(유형) 대분류 목록 (lclsSystmCode2). */
  async categories(): Promise<CodeItem[]> {
    if (this.categoriesCache === null) {
      const page = await this.kto().lclsSystmCode();
      this.categoriesCache = toCodeItems(page.items);
    }
    return this.categoriesCache;
  }
}

function toCodeItems(items: readonly Record<string, unknown>[]): CodeItem[] {
  return items
    .map((x) => ({ code: String(x.code ?? ''), name: String(x.name ?? '') }))
    .filter((c) => c.code !== '' && c.name !== '');
}
