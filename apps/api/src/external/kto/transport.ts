import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { KtoOperation } from '@tourlint/shared';
import { KTO_OPERATIONS } from '@tourlint/shared';
import { KtoFetchError, KtoTimeoutError } from './kto.errors';

/**
 * 공사 OpenAPI 로 나가는 **유일한 출구**.
 *
 * 클라이언트는 HTTP 를 모른다. 덕분에 실호출과 픽스처 리플레이를 같은 코드로 검증한다.
 * (EI-CM-003 어댑터 계층 · FR-OP-009 목업 전면 대체 금지 — 리플레이는 **개발 환경 전용**이다)
 */
export interface KtoTransport {
  request(operation: KtoOperation, params: KtoParams): Promise<KtoTransportResult>;
  /** 호출 로그의 provider 표기가 달라지지 않도록 이름을 노출한다 */
  readonly kind: 'http' | 'fixture';
}

export type KtoParams = Readonly<Record<string, string | number>>;

export interface KtoTransportResult {
  readonly body: string;
  /** 픽스처 리플레이는 HTTP 를 타지 않으므로 null 이다 */
  readonly httpStatus: number | null;
}

// ── 실호출 ────────────────────────────────────────────────────────────

export interface HttpKtoTransportOptions {
  readonly serviceKey: string;
  readonly baseUrl?: string;
  /** 응답 타임아웃 (EI-CM-004). 환경변수로 조정한다 */
  readonly timeoutMs?: number;
  /** 테스트 주입용. 기본은 전역 fetch */
  readonly fetchImpl?: typeof globalThis.fetch;
}

const DEFAULT_BASE_URL = 'https://apis.data.go.kr/B551011/KorService2';
const DEFAULT_TIMEOUT_MS = 10_000;

export class HttpKtoTransport implements KtoTransport {
  readonly kind = 'http' as const;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: HttpKtoTransportOptions) {
    if (!options.serviceKey) {
      // 키를 못 읽은 채 조용히 호출하면 전부 인증 오류로 돌아와 원인이 흐려진다
      throw new Error('KTO 인증키가 비어 있다. 환경변수 KTO_SERVICE_KEY 를 확인할 것');
    }
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async request(operation: KtoOperation, params: KtoParams): Promise<KtoTransportResult> {
    const url = this.buildUrl(operation, params);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Accept: 'application/json' },
      });
    } catch (e) {
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        throw new KtoTimeoutError(operation, this.timeoutMs);
      }
      // ⚠️ url 을 메시지에 넣지 않는다 — 인증키가 붙어 있다 (EI-CM-002)
      throw new KtoFetchError(operation, `네트워크 오류: ${(e as Error).name}`);
    }

    const body = await response.text();
    if (!response.ok) {
      // 본문은 담지 않는다. 상태 코드만으로 충분하고, 본문에는 원문이 섞인다
      throw new KtoFetchError(operation, `HTTP ${response.status}`, response.status);
    }
    return { body, httpStatus: response.status };
  }

  /**
   * 인증키는 여기서만 문자열에 닿는다. 반환된 URL 을 로그·오류·예외에 절대 싣지 않는다.
   */
  private buildUrl(operation: KtoOperation, params: KtoParams): string {
    const url = new URL(`${this.baseUrl}/${operation}`);
    // 공사 필수 공통 파라미터
    url.searchParams.set('serviceKey', this.options.serviceKey);
    url.searchParams.set('MobileOS', 'ETC');
    url.searchParams.set('MobileApp', 'TourLint');
    url.searchParams.set('_type', 'json');
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
    return url.toString();
  }
}

// ── 픽스처 리플레이 ───────────────────────────────────────────────────

/**
 * `fixtures/kto/` 의 **실호출 스냅샷**을 그대로 되돌려준다 (`KTO_MODE=fixture`).
 *
 * 왜 필요한가 — 개발·테스트가 일일 호출 예산을 쓰지 않게 하려고. 목업이 아니라
 * 실제 응답을 녹화한 것이므로 실측 함정이 그대로 살아 있다.
 *
 * **없는 키는 조용히 대체하지 않고 던진다.** 다른 관광지 응답을 슬쩍 돌려주면
 * 검수 결과가 그럴듯하게 틀린다 — 회귀 정답셋의 의미가 사라진다.
 */
export class FixtureKtoTransport implements KtoTransport {
  readonly kind = 'fixture' as const;

  /** `operation` 또는 `operation:contentId` → 파일 경로 */
  private readonly index = new Map<string, string>();

  constructor(private readonly fixtureDir: string) {
    this.buildIndex();
  }

  // 파일 읽기는 동기지만 인터페이스는 실호출과 같아야 한다 — 호출자가 두 모드를 구분하지 않는다
  async request(operation: KtoOperation, params: KtoParams): Promise<KtoTransportResult> {
    const contentId = params.contentId ?? params.contentid;
    const key = contentId === undefined ? operation : `${operation}:${contentId}`;

    const file = this.index.get(key);
    if (file !== undefined) {
      return { body: readFileSync(file, 'utf8'), httpStatus: null };
    }

    throw new KtoFetchError(
      operation,
      contentId === undefined
        ? `픽스처가 없다. ${this.fixtureDir} 에 ${operation} 스냅샷을 추가할 것`
        : `픽스처가 없다: contentId=${contentId}. 보유 목록: ${this.availableContentIds(operation).join(', ') || '없음'}`,
    );
  }

  /** 어떤 콘텐츠를 리플레이할 수 있는지 — 회귀 케이스를 고를 때 쓴다 */
  availableContentIds(operation: KtoOperation): string[] {
    const prefix = `${operation}:`;
    return [...this.index.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .sort();
  }

  /**
   * 파일명이 아니라 **본문의 `contentid`** 로 색인한다.
   * 파일명 규칙(`12_125769.json` · `type15_695592.json`)은 사람이 읽기 위한 것이고,
   * 조회 키는 응답이 스스로 밝힌 값이어야 어긋나지 않는다.
   */
  private buildIndex(): void {
    for (const name of readdirSync(this.fixtureDir).sort()) {
      if (!name.endsWith('.json') || name.startsWith('_')) continue;
      const path = join(this.fixtureDir, name);
      const operation = operationFromFileName(name);
      if (operation === null) continue;

      if (DETAIL_OPERATIONS.has(operation)) {
        const contentId = readContentId(path);
        if (contentId !== null) this.index.set(`${operation}:${contentId}`, path);
        continue;
      }
      // 목록·코드 조회는 먼저 발견한 스냅샷 하나만 쓴다
      if (!this.index.has(operation)) this.index.set(operation, path);
    }
  }
}

const DETAIL_OPERATIONS = new Set<KtoOperation>(['detailCommon2', 'detailIntro2']);

/**
 * 파일명에서 오퍼레이션을 알아낸다.
 *   `04_searchKeyword2.json`      → searchKeyword2
 *   `10_detailIntro2_12.json`     → detailIntro2
 *   `12_125769.json`              → detailIntro2  (유형_콘텐츠id 규칙)
 *   `type15_695592.json`          → detailIntro2
 */
function operationFromFileName(name: string): KtoOperation | null {
  const named = /^\d+_([A-Za-z][A-Za-z0-9]*2)(?:_|\.)/.exec(name);
  if (named !== null) {
    const op = named[1] as KtoOperation;
    return (KTO_OPERATIONS as readonly string[]).includes(op) ? op : null;
  }
  if (/^(?:type)?(?:12|14|15|28|32|38|39)_\d+\.json$/.test(name)) return 'detailIntro2';
  return null;
}

function readContentId(path: string): string | null {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const item = (parsed as { response?: { body?: { items?: { item?: unknown } } } })?.response?.body?.items?.item;
  const first = Array.isArray(item) ? item[0] : item;
  const id = (first as Record<string, unknown> | undefined)?.contentid;
  return id === undefined || id === null ? null : String(id);
}
