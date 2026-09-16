import { createHttpFetch, isTimeoutError } from '../http-client';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { KtoOperation, KtoService } from '@tourlint/shared';
import { KTO_OPERATIONS, KTO_OPERATION_PATH, KTO_SERVICE_OF } from '@tourlint/shared';
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
  /** 국문 관광정보 베이스 URL (`KTO_BASE_URL`). 새 서비스 5종에는 적용하지 않는다 */
  readonly baseUrl?: string;
  /** 서비스별 베이스 URL 덮어쓰기. 없는 서비스는 `KTO_BASE_URLS` 를 쓴다 */
  readonly baseUrls?: Partial<Record<KtoService, string>>;
  /** 응답 타임아웃 (EI-CM-004). 환경변수로 조정한다 */
  readonly timeoutMs?: number;
  /** 테스트 주입용. 기본은 전역 fetch */
  readonly fetchImpl?: typeof globalThis.fetch;
}

/**
 * 서비스별 베이스 URL (외부 연동 3-1). 활용신청과 하루 한도가 서비스마다 따로라
 * 오퍼레이션이 어느 서비스인지는 `KTO_SERVICE_OF` 로 고른다.
 */
export const KTO_BASE_URLS: Readonly<Record<KtoService, string>> = {
  KOR: 'https://apis.data.go.kr/B551011/KorService2',
  PET: 'https://apis.data.go.kr/B551011/KorPetTourService2',
  WITH: 'https://apis.data.go.kr/B551011/KorWithService2',
  RELATED: 'https://apis.data.go.kr/B551011/TarRlteTarService1',
  DURUNUBI: 'https://apis.data.go.kr/B551011/Durunubi',
  VISITOR: 'https://apis.data.go.kr/B551011/DataLabService',
};
const DEFAULT_TIMEOUT_MS = 10_000;

export class HttpKtoTransport implements KtoTransport {
  readonly kind = 'http' as const;

  private readonly baseUrls: Readonly<Record<KtoService, string>>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: HttpKtoTransportOptions) {
    if (!options.serviceKey) {
      // 키를 못 읽은 채 조용히 호출하면 전부 인증 오류로 돌아와 원인이 흐려진다
      throw new Error('KTO 인증키가 비어 있다. 환경변수 KTO_SERVICE_KEY 를 확인할 것');
    }
    this.baseUrls = {
      ...KTO_BASE_URLS,
      ...(options.baseUrl === undefined ? {} : { KOR: options.baseUrl }),
      ...options.baseUrls,
    };
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
   *
   * 경로는 오퍼레이션 이름이 아니라 `KTO_OPERATION_PATH` 에서 고른다 — 무장애 · 반려동물의
   * 지역 목록은 국문과 같은 `areaBasedList2` 라 이름에 서비스를 붙여 두었다.
   */
  private buildUrl(operation: KtoOperation, params: KtoParams): string {
    const base = this.baseUrls[KTO_SERVICE_OF[operation]];
    const url = new URL(`${base}/${KTO_OPERATION_PATH[operation]}`);
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
        ? `픽스처가 없다. ${this.fixtureDir} 에 ${key} 스냅샷을 추가할 것`
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
      const suffix = name.slice(name.indexOf(operation) + operation.length).replace(/\.json$/, '');
      const condition = CONDITIONED_LISTS[operation]?.fromSuffix(suffix) ?? null;
      if (condition !== null) {
        this.index.set(`${operation}:${condition}`, path);
        continue;
      }
      // 조건 없는 목록·코드 조회는 먼저 발견한 스냅샷 하나만 쓴다
      if (!this.index.has(operation)) this.index.set(operation, path);
    }
  }
}

/** 본문 `contentid` 로 색인하는 상세 조회 */
const DETAIL_OPERATIONS = new Set<KtoOperation>(['detailCommon2', 'detailIntro2', 'detailPetTour2', 'detailWithTour2']);

/**
 * 조건이 결과를 가르는 목록 조회 — **조건까지 키에 넣는다.**
 *
 * 파일명 접미(`_51_150`)와 요청 파라미터가 같은 조건 문자열로 모인다. 다른 조건의 스냅샷을
 * 돌려주면 필터 · 순위가 그럴듯하게 틀리므로(휠체어 가능 곳이 다른 지역 목록으로 정해진다)
 * 조건이 붙은 요청은 조건 없는 스냅샷으로 물러나지 않는다. 조건이 없는 요청(`fromParams` 가
 * null)만 오퍼레이션 이름의 스냅샷을 쓴다.
 */
const CONDITIONED_LISTS: Partial<Record<KtoOperation, {
  fromSuffix(suffix: string): string | null;
  fromParams(params: KtoParams): string | null;
}>> = {
  // 시도(파라미터 없음)는 `_sido` 처럼 숫자가 아닌 접미, 시군구는 `_<시도코드>` 로 캡처한다
  ldongCode2: {
    fromSuffix: (s) => matchJoin(/^_(\d+)$/, s, (m) => `regn:${m[1]}`),
    fromParams: (p) => (p.lDongRegnCd === undefined ? null : `regn:${p.lDongRegnCd}`),
  },
  // 검색 스냅샷은 `04_searchKeyword2_경포대.json` 처럼 키워드를 파일명에 담는다
  searchKeyword2: {
    fromSuffix: (s) => matchJoin(/^_(.+)$/, s, (m) => `kw:${m[1]}`),
    fromParams: (p) => (typeof p.keyword === 'string' && p.keyword !== '' ? `kw:${p.keyword}` : null),
  },
  // 연관 관광지는 키워드 스냅샷이 없으면 던진다 — 다른 기준 관광지의 순위를 붙이면 안 된다
  searchKeyword1: {
    fromSuffix: (s) => matchJoin(/^_(.+)$/, s, (m) => `kw:${m[1]}`),
    fromParams: (p) => `kw:${p.keyword ?? ''}`,
  },
  // 무장애 · 반려동물 지역 목록 `_51_150` = 시도 · 시군구
  withAreaBasedList2: { fromSuffix: ldongSuffix, fromParams: ldongParams },
  petAreaBasedList2: { fromSuffix: ldongSuffix, fromParams: ldongParams },
  // 근처 3km 칩 `_FD` · `_FD_FD05` = 요청에 넣은 분류 1 · 2 · 3단계. 분류 없는 요청은 기존 스냅샷을 쓴다
  locationBasedList2: {
    fromSuffix: (s) => matchJoin(/^_([A-Z]{2}(?:_[A-Z]{2}\d{2}(?:_[A-Z]{2}\d{6})?)?)$/, s, (m) => `lcls:${(m[1] ?? '').replaceAll('_', ':')}`),
    fromParams: (p) => {
      const codes = [p.lclsSystm1, p.lclsSystm2, p.lclsSystm3].filter((c) => c !== undefined);
      return codes.length === 0 ? null : `lcls:${codes.join(':')}`;
    },
  },
  // 방문자수 `_20250901_20250930` = 시작일 · 종료일
  locgoRegnVisitrDDList: {
    fromSuffix: (s) => matchJoin(/^_(\d{8})_(\d{8})$/, s, (m) => `ymd:${m[1]}:${m[2]}`),
    fromParams: (p) => `ymd:${p.startYmd ?? ''}:${p.endYmd ?? ''}`,
  },
};

function ldongSuffix(suffix: string): string | null {
  return matchJoin(/^_(\d{2})_(\d{3})$/, suffix, (m) => `ldong:${m[1]}:${m[2]}`);
}

function ldongParams(params: KtoParams): string {
  return `ldong:${params.lDongRegnCd ?? ''}:${params.lDongSignguCd ?? ''}`;
}

function matchJoin(re: RegExp, value: string, join: (m: RegExpExecArray) => string): string | null {
  const m = re.exec(value);
  return m === null ? null : join(m);
}

/**
 * 파일명에서 오퍼레이션을 알아낸다.
 *   `04_searchKeyword2.json`      → searchKeyword2
 *   `10_detailIntro2_12.json`     → detailIntro2
 *   `24_searchKeyword1_경포대.json` → searchKeyword1  (이름이 2 로 끝나지 않는 새 서비스)
 *   `12_125769.json`              → detailIntro2  (유형_콘텐츠id 규칙)
 *   `type15_695592.json`          → detailIntro2
 */
function operationFromFileName(name: string): KtoOperation | null {
  const named = /^\d+_([A-Za-z][A-Za-z0-9]*)(?:_|\.)/.exec(name);
  if (named !== null) {
    const op = named[1] as KtoOperation;
    return (KTO_OPERATIONS as readonly string[]).includes(op) ? op : null;
  }
  if (/^(?:type)?(?:12|14|15|28|32|38|39)_\d+\.json$/.test(name)) return 'detailIntro2';
  return null;
}

/**
 * 요청 → 색인 키. 상세는 contentId, 조건이 결과를 가르는 목록은 조건(`CONDITIONED_LISTS`)을 붙인다.
 * 시군구 파라미터가 붙은 조회는 시도 스냅샷으로 대체되지 않는다 — 없으면 정직하게 던진다.
 *
 * 검색은 **키워드까지 키에 넣는다.** 오퍼레이션만으로 색인하면 어떤 검색어를 넣어도 같은
 * 후보가 나와, 관통 검증에서 후보 정확도를 볼 수 없다 (이슈 #350).
 */
function fixtureKey(
  operation: KtoOperation,
  params: KtoParams,
  contentId: string | number | undefined,
): string {
  if (contentId !== undefined && DETAIL_OPERATIONS.has(operation)) return `${operation}:${contentId}`;
  const condition = CONDITIONED_LISTS[operation]?.fromParams(params) ?? null;
  return condition === null ? operation : `${operation}:${condition}`;
}

function readContentId(path: string): string | null {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const item = (parsed as { response?: { body?: { items?: { item?: unknown } } } })?.response?.body?.items?.item;
  const first = Array.isArray(item) ? item[0] : item;
  const id = (first as Record<string, unknown> | undefined)?.contentid;
  return id === undefined || id === null ? null : String(id);
}
