import { createHttpFetch, isTimeoutError } from '../http-client';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { KtoOperation } from '@tourlint/shared';
import { KTO_OPERATIONS } from '@tourlint/shared';
import { FixtureMissingError, KtoFetchError, KtoTimeoutError } from './kto.errors';

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
    // 연결 3초 · 응답 10초를 나눠 건다 (EI-CM-004)
    this.fetchImpl = options.fetchImpl ?? createHttpFetch();
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
      // 연결 타임아웃도 타임아웃이다 — undici 는 이름이 아니라 cause.code 로 알린다
      if (isTimeoutError(e)) throw new KtoTimeoutError(operation, this.timeoutMs);
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

  /**
   * 오퍼레이션별 리플레이 횟수. 중복 제거·캐시가 실제로 호출을 줄이는지 세는 자리다 —
   * 리플레이는 호출 로그를 남기지 않으므로(FR-OP-007) 로그로는 셀 수 없다.
   */
  readonly replayCounts = new Map<KtoOperation, number>();

  /** `operation` 또는 `operation:contentId` → 파일 경로 */
  private readonly index = new Map<string, string>();

  constructor(private readonly fixtureDir: string) {
    this.buildIndex();
  }

  // 파일 읽기는 동기지만 인터페이스는 실호출과 같아야 한다 — 호출자가 두 모드를 구분하지 않는다
  async request(operation: KtoOperation, params: KtoParams): Promise<KtoTransportResult> {
    this.replayCounts.set(operation, (this.replayCounts.get(operation) ?? 0) + 1);
    const contentId = params.contentId ?? params.contentid;
    const key = fixtureKey(operation, params, contentId);

    /*
     * 키워드별 스냅샷이 없으면 **기본 스냅샷으로 물러난다.** 검색어마다 스냅샷을 뜨는 것은
     * 예산이라, 아직 안 뜬 검색어도 후보 목록은 받아 볼 수 있어야 한다.
     */
    const file = this.index.get(key) ?? (key.startsWith('searchKeyword2:kw:') ? this.index.get('searchKeyword2') : undefined);
    if (file !== undefined) {
      return { body: readFileSync(file, 'utf8'), httpStatus: null };
    }

    throw new FixtureMissingError(
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
      // 지역 코드는 시도(파라미터 없음)와 시군구(lDongRegnCd 별)를 나눠 색인한다.
      // 시군구 fixture 는 `_<지역코드>.json`(숫자) 규칙으로 캡처하면 자동 인식된다.
      // `_sido`·`_gangwon` 처럼 숫자가 아닌 접미사는 시도(파라미터 없음)로 취급한다.
      if (operation === 'ldongCode2') {
        const m = /_ldongCode2_(\d+)\.json$/.exec(name);
        if (m !== null) {
          this.index.set(`ldongCode2:regn:${m[1]}`, path);
          continue;
        }
      }
      // 검색 스냅샷은 `04_searchKeyword2_경포대.json` 처럼 키워드를 파일명에 담는다
      if (operation === 'searchKeyword2') {
        const kw = /_searchKeyword2_(.+)\.json$/.exec(name);
        if (kw !== null) {
          this.index.set(`searchKeyword2:kw:${kw[1] ?? ''}`, path);
          continue;
        }
      }
      // 그 밖의 목록·코드 조회는 먼저 발견한 스냅샷 하나만 쓴다
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

/**
 * 요청 → 색인 키. 상세는 contentId, 지역 코드는 시군구(lDongRegnCd)를 구분한다.
 * 시군구 파라미터가 붙은 조회는 시도 스냅샷으로 대체되지 않는다 — 없으면 정직하게 던진다.
 */
function fixtureKey(
  operation: KtoOperation,
  params: KtoParams,
  contentId: string | number | undefined,
): string {
  if (contentId !== undefined) return `${operation}:${contentId}`;
  if (operation === 'ldongCode2' && params.lDongRegnCd !== undefined) {
    return `ldongCode2:regn:${params.lDongRegnCd}`;
  }
  /*
   * 검색은 **키워드까지 키에 넣는다.** 오퍼레이션만으로 색인하면 어떤 검색어를 넣어도 같은
   * 후보가 나와, 관통 검증에서 후보 정확도를 볼 수 없다 (이슈 #350).
   */
  if (operation === 'searchKeyword2' && typeof params.keyword === 'string' && params.keyword !== '') {
    return `searchKeyword2:kw:${params.keyword}`;
  }
  return operation;
}

function readContentId(path: string): string | null {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const item = (parsed as { response?: { body?: { items?: { item?: unknown } } } })?.response?.body?.items?.item;
  const first = Array.isArray(item) ? item[0] : item;
  const id = (first as Record<string, unknown> | undefined)?.contentid;
  return id === undefined || id === null ? null : String(id);
}
