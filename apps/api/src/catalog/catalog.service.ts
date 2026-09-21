import { FixtureMissingError, type KtoClient } from '../external/kto';

/**
 * 지역·분류 코드 조회 (F01 등록 화면의 지역·유형 드롭다운 · UI-S2-004·007).
 *
 * mock 을 대체한 실엔진이다 — 공사 `ldongCode2` · `lclsSystmCode2` 를 KtoClient 로 부른다
 * (개발에서는 fixtures/kto 리플레이라 예산을 쓰지 않는다).
 *
 * 코드 목록은 거의 바뀌지 않으므로 프로세스 메모리에 캐시한다. 요청마다 공사를 부르면
 * 운영에서 화면을 열 때마다 일일 예산을 갉아먹는다 — 참조 조회는 그럴 이유가 없다.
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
  /**
   * @param ktoFactory 사용자 요청이 쓰는 클라이언트
   * @param warmFactory 부팅 예열이 쓰는 클라이언트. 기다리는 사람이 없어 시간을 더 준다 (#662)
   */
  constructor(
    private readonly ktoFactory: () => KtoClient,
    private readonly warmFactory: () => KtoClient = ktoFactory,
  ) {}

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
   * 부팅 직후 코드 목록을 미리 받아 둔다 (#662).
   *
   * 한 번 성공하면 그 배포가 사는 동안 캐시가 답한다 — 첫 사용자가 실패를 대신 맞지
   * 않는다. **걸린 시간을 남긴다:** 운영에서 공사로 나가는 길이 느린 것인지 막힌 것인지는
   * 이 숫자로만 갈린다. 실패해도 던지지 않는다. 부팅을 막을 일이 아니다.
   */
  /** @returns 공사에 한 번이라도 닿았는가. `/health` 가 이 값으로 배포 검사를 가른다 (#700) */
  async warm(log: (line: string) => void, backoffMs = BACKOFF_MS): Promise<boolean> {
    const kto = this.warmFactory();
    const regions = await this.warmOne(log, backoffMs, '지역 코드', async () => {
      this.regionsCache = toCodeItems((await kto.ldongCode()).items);
      return this.regionsCache.length;
    });
    const categories = await this.warmOne(log, backoffMs, '분류 코드', async () => {
      this.categoriesCache = toCodeItems((await kto.lclsSystmCode()).items);
      return this.categoriesCache.length;
    });
    return regions || categories;
  }

  private async warmOne(
    log: (line: string) => void,
    backoffMs: number,
    label: string,
    run: () => Promise<number>,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= WARM_ATTEMPTS; attempt += 1) {
      const started = Date.now();
      try {
        const count = await run();
        log(`${label} 예열 ${count}건 · ${Date.now() - started}ms · ${attempt}번째 시도`);
        return true;
      } catch (e) {
        // 시도마다 남긴다 — 걸린 시간이 느린 길과 막힌 길을 가른다
        log(`${label} 예열 ${attempt}번째 실패 · ${Date.now() - started}ms · ${e instanceof Error ? e.message : String(e)}`);
        if (attempt < WARM_ATTEMPTS) await sleep(backoffMs * attempt);
      }
    }
    return false;
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

/** 부팅 예열 시도 횟수 */
const WARM_ATTEMPTS = 3;
/** 다시 시도하기 전 기다리는 시간. 시도마다 곱해 늘린다 */
const BACKOFF_MS = 700;

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function toCodeItems(items: readonly Record<string, unknown>[]): CodeItem[] {
  return items
    .map((x) => ({ code: String(x.code ?? ''), name: String(x.name ?? '') }))
    .filter((c) => c.code !== '' && c.name !== '');
}
