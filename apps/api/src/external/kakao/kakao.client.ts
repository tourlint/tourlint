import { createHttpFetch, isTimeoutError } from '../http-client';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ApiCallLogEntry, ApiCallLogger, CallStatus } from '../api-call-log';
import { RouteNotFoundError, RouteProviderError } from './kakao.errors';

/**
 * 카카오모빌리티 길찾기 어댑터 (EI-KM-001 ~ 009).
 *
 * 오퍼레이션은 둘뿐이다.
 *   `future/directions`  1급. 상품의 **여행 날짜와 출발 시각** 기준 (FR-RU-085)
 *   `directions`         폴백. 현재 시각 기준이며 화면에 그 사실을 표기해야 한다
 *
 * 응답에서 쓰는 값은 `routes[0].result_code` · `summary.distance`(m) · `summary.duration`(초)
 * 셋뿐이다. `fare` · `taxi` 요금은 쓰지 않는다 (EI-KM-004).
 *
 * ⚠️ 공사 좌표는 WGS84 경도 · 위도다. **좌표계 변환 없이 그대로 넘긴다** (FR-RU-080).
 */

const BASE_URL = 'https://apis-navi.kakaomobility.com';
const DEFAULT_TIMEOUT_MS = 10_000;

export type KakaoOperation = 'future/directions' | 'directions';

export interface Coordinate {
  /** 경도 */
  readonly x: number;
  /** 위도 */
  readonly y: number;
}

export interface RouteResult {
  readonly distanceMeters: number;
  readonly durationSeconds: number;
  /** 미래 운행 정보로 산출했는가. false 면 화면에 "현재 시각 기준" 을 표기해야 한다 */
  readonly futureBased: boolean;
}

export interface KakaoTransportResult {
  readonly body: string;
  readonly httpStatus: number | null;
}

export interface KakaoTransport {
  request(operation: KakaoOperation, params: Readonly<Record<string, string>>): Promise<KakaoTransportResult>;
  readonly kind: 'http' | 'fixture';
}

export class HttpKakaoTransport implements KakaoTransport {
  readonly kind = 'http' as const;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(
    private readonly restApiKey: string,
    options: { timeoutMs?: number; fetchImpl?: typeof globalThis.fetch } = {},
  ) {
    if (!restApiKey) {
      // 키 없이 호출하면 전부 401 로 돌아와 원인이 흐려진다
      throw new Error('카카오 REST API 키가 비어 있다. 환경변수 KAKAO_REST_API_KEY 를 확인할 것');
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // 연결 3초 · 응답 10초를 나눠 건다 (EI-CM-004)
    this.fetchImpl = options.fetchImpl ?? createHttpFetch();
  }

  async request(operation: KakaoOperation, params: Readonly<Record<string, string>>): Promise<KakaoTransportResult> {
    const url = new URL(`${BASE_URL}/v1/${operation}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        // 인증키는 헤더에만 실린다. URL 을 로그·오류에 담지 않는 이유이기도 하다
        headers: { Authorization: `KakaoAK ${this.restApiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      // 이름만 담는다. 메시지·URL 에는 인증키가 섞일 수 있다 (EI-CM-002)
      throw new RouteProviderError(isTimeoutError(e) ? 'TIMEOUT' : (e as Error).name);
    }

    const body = await response.text();
    // 본문을 메시지에 담지 않는다. 상태 코드만으로 충분하다
    if (!response.ok) throw new RouteProviderError(`HTTP ${response.status}`, response.status);
    return { body, httpStatus: response.status };
  }
}

/**
 * `fixtures/kakao/` 스냅샷 리플레이 (`KAKAO_MODE=fixture`).
 *
 * ⚠️ **좌표와 무관하게 같은 응답을 준다.** 스냅샷이 오퍼레이션당 하나뿐이라 거리·시간이
 * 실제 구간을 반영하지 않는다. 파이프라인 배선과 판정 경로를 확인하는 용도이지
 * 이동시간 값 자체를 검증하는 용도가 아니다. 값 검증은 규칙 단위 테스트가 한다.
 */
export class FixtureKakaoTransport implements KakaoTransport {
  readonly kind = 'fixture' as const;

  constructor(private readonly fixtureDir: string) {}

  // 파일 읽기는 동기지만 인터페이스는 실호출과 같아야 한다
  async request(operation: KakaoOperation): Promise<KakaoTransportResult> {
    const file = join(this.fixtureDir, operation === 'future/directions' ? 'future_directions.json' : 'directions.json');
    if (!existsSync(file)) throw new RouteProviderError(`픽스처가 없다: ${file}`);
    return { body: readFileSync(file, 'utf8'), httpStatus: null };
  }
}

/** 환경변수 하나로 실호출 ↔ 리플레이를 고른다. 운영에서 리플레이는 거부한다 (FR-OP-009) */
export function createKakaoTransport(env: NodeJS.ProcessEnv = process.env): KakaoTransport {
  if (env.KAKAO_MODE === 'fixture') {
    if (env.NODE_ENV === 'production') {
      throw new Error('KAKAO_MODE=fixture 는 운영에서 쓸 수 없다 (FR-OP-009)');
    }
    return new FixtureKakaoTransport(env.KAKAO_FIXTURE_DIR ?? resolve(process.cwd(), '../../fixtures/kakao'));
  }
  return new HttpKakaoTransport(env.KAKAO_REST_API_KEY ?? '');
}

export interface KakaoClientOptions {
  readonly transport: KakaoTransport;
  readonly logger: ApiCallLogger;
  readonly clock?: () => Date;
  readonly auditRunId?: number | null;
}

export class KakaoMobilityClient {
  private readonly transport: KakaoTransport;
  private readonly logger: ApiCallLogger;
  private readonly clock: () => Date;
  private readonly auditRunId: number | null;

  constructor(options: KakaoClientOptions) {
    this.transport = options.transport;
    this.logger = options.logger;
    this.clock = options.clock ?? ((): Date => new Date());
    this.auditRunId = options.auditRunId ?? null;
  }

  /**
   * 두 지점 사이 자동차 경로.
   *
   * `departureAt` 이 있으면 미래 운행 정보를 먼저 쓴다. 실패하면 현재 시각 기준으로 폴백하고
   * 그 사실을 `futureBased: false` 로 알린다 (EI-KM-002 · FR-RU-085).
   */
  async route(origin: Coordinate, destination: Coordinate, departureAt: string | null): Promise<RouteResult> {
    const base = {
      // WGS84 경도,위도 그대로. 상세 경로는 쓰지 않으므로 요청하지 않는다 (EI-KM-003)
      origin: `${origin.x},${origin.y}`,
      destination: `${destination.x},${destination.y}`,
      summary: 'true',
    };

    if (departureAt !== null) {
      try {
        return { ...(await this.call('future/directions', { ...base, departure_time: departureAt })), futureBased: true };
      } catch (e) {
        // 출발 시각이 과거면 미래 운행 정보를 쓸 수 없다. 폴백은 정상 경로다
        if (e instanceof RouteNotFoundError) throw e;
      }
    }
    return { ...(await this.call('directions', base)), futureBased: false };
  }

  private async call(
    operation: KakaoOperation,
    params: Readonly<Record<string, string>>,
  ): Promise<Omit<RouteResult, 'futureBased'>> {
    const startedAt = this.clock();
    let status: CallStatus = 'FAIL';
    let httpStatus: number | null = null;
    let resultCode: string | null = null;

    try {
      const res = await this.transport.request(operation, params);
      httpStatus = res.httpStatus;
      const summary = readSummary(res.body);
      resultCode = String(summary.resultCode);
      status = 'OK';
      return { distanceMeters: summary.distanceMeters, durationSeconds: summary.durationSeconds };
    } catch (e) {
      if (e instanceof RouteNotFoundError) resultCode = String(e.resultCode);
      if (e instanceof RouteProviderError) httpStatus = e.httpStatus ?? httpStatus;
      throw e;
    } finally {
      this.record(operation, startedAt, status, httpStatus, resultCode);
    }
  }

  private record(
    operation: KakaoOperation,
    startedAt: Date,
    status: CallStatus,
    httpStatus: number | null,
    resultCode: string | null,
  ): void {
    const entry: ApiCallLogEntry = {
      provider: 'KAKAO_MOBILITY',
      operation,
      calledAt: startedAt,
      status,
      httpStatus,
      resultCode,
      latencyMs: Math.max(0, this.clock().getTime() - startedAt.getTime()),
      auditRunId: this.auditRunId,
    };
    try {
      const pending = this.logger.record(entry);
      if (pending instanceof Promise) void pending.catch(() => undefined);
    } catch {
      // 증빙 로깅 실패가 검수를 멈추면 안 된다
    }
  }
}

/**
 * 응답에서 셋만 꺼낸다 — `result_code` · `distance` · `duration`.
 *
 * **`result_code` 를 반드시 본다** (EI-KM-005). HTTP 200 이어도 0 이 아니면 경로가 없는 것이고,
 * 그걸 넘기면 "이동시간 0분" 으로 둔갑한다.
 */
export function readSummary(body: string): {
  resultCode: number;
  distanceMeters: number;
  durationSeconds: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new RouteProviderError('JSON 으로 해석할 수 없는 응답');
  }

  const routes = (parsed as { routes?: unknown[] }).routes;
  const first = Array.isArray(routes) ? routes[0] : undefined;
  if (first === undefined) throw new RouteProviderError('응답에 routes 가 없다');

  const route = first as { result_code?: number; result_msg?: string; summary?: { distance?: number; duration?: number } };
  const resultCode = Number(route.result_code ?? -1);
  if (resultCode !== 0) throw new RouteNotFoundError(resultCode, String(route.result_msg ?? ''));

  const distance = Number(route.summary?.distance);
  const duration = Number(route.summary?.duration);
  if (!Number.isFinite(distance) || !Number.isFinite(duration)) {
    throw new RouteProviderError('summary 에 distance·duration 이 없다');
  }
  return { resultCode, distanceMeters: distance, durationSeconds: duration };
}
