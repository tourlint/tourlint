import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHttpFetch, isTimeoutError } from '../http-client';
import type { ApiCallLogEntry, ApiCallLogger, CallStatus } from '../api-call-log';
import type { IsoDate } from '../../engine/calendar/dates';
import { ForecastMissingError, ForecastProviderError } from './kma.errors';
import type { GridPoint } from './grid';
import { MID_OFFSET_RANGE, midTargetDate, type MidPublication, type ShortPublication } from './publication';
import type { MidLandRegionId } from './mid-region';

/**
 * 기상청 예보 어댑터 (EI-WX-001 ~ 008).
 *
 * 오퍼레이션은 둘이다.
 *   `getVilageFcst`   단기예보. 격자(`nx` · `ny`) 단위. D+0 ~ D+3
 *   `getMidLandFcst`  중기육상예보. 예보구역(`regId`) 단위. D+4 ~ D+10
 *
 * 쓰는 값은 **강수확률뿐이다** — 단기는 `POP`, 중기는 `rnSt*` (EI-WX-002 · 003).
 * 기온 · 하늘상태 · 풍속은 읽지 않는다.
 *
 * ⚠️ 인증키는 `KMA_SERVICE_KEY` 로 분리해 둔다. 문자열 자체는 공사 인증키와 같지만
 *    (data.go.kr 은 계정당 키 하나다) 어댑터가 다른 연동의 설정을 읽으면 안 된다
 *    (EI-WX-001 · NF-MT-003).
 */

const SHORT_BASE_URL = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';
const MID_BASE_URL = 'https://apis.data.go.kr/1360000/MidFcstInfoService';
const DEFAULT_TIMEOUT_MS = 10_000;

/** 단기예보에서 읽는 유일한 항목 (EI-WX-002) */
const POP_CATEGORY = 'POP';

/** 정상 응답. 공사(`0000`)와 다르다 — 기상청은 `00` 이다 */
const RESULT_OK = '00';
/** 발표분이 없다 */
const RESULT_NO_DATA = '03';
/** 조회 기간을 벗어났다 — 「최대 조회 기간은 오늘 기준으로 1일 전까지입니다」 */
const RESULT_OUT_OF_RANGE = '99';

export type KmaOperation = 'getVilageFcst' | 'getMidLandFcst';

export interface KmaTransportResult {
  readonly body: string;
  readonly httpStatus: number | null;
}

export interface KmaTransport {
  request(operation: KmaOperation, params: Readonly<Record<string, string | number>>): Promise<KmaTransportResult>;
  readonly kind: 'http' | 'fixture';
}

export class HttpKmaTransport implements KmaTransport {
  readonly kind = 'http' as const;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(
    private readonly serviceKey: string,
    options: { timeoutMs?: number; fetchImpl?: typeof globalThis.fetch } = {},
  ) {
    if (!serviceKey) {
      // 키 없이 부르면 전부 접근 거부로 돌아와 원인이 흐려진다
      throw new Error('기상청 인증키가 비어 있다. 환경변수 KMA_SERVICE_KEY 를 확인할 것');
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // 연결 3초 · 응답 10초를 나눠 건다 (EI-CM-004)
    this.fetchImpl = options.fetchImpl ?? createHttpFetch();
  }

  async request(
    operation: KmaOperation,
    params: Readonly<Record<string, string | number>>,
  ): Promise<KmaTransportResult> {
    const base = operation === 'getVilageFcst' ? SHORT_BASE_URL : MID_BASE_URL;
    const url = new URL(`${base}/${operation}`);
    url.searchParams.set('serviceKey', this.serviceKey);
    url.searchParams.set('dataType', 'JSON');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      // ⚠️ url 도 메시지도 담지 않는다 — 인증키가 쿼리에 붙어 있다 (EI-CM-002)
      throw new ForecastProviderError(isTimeoutError(e) ? 'TIMEOUT' : (e as Error).name);
    }

    const body = await response.text();
    if (!response.ok) throw new ForecastProviderError(`HTTP ${response.status}`, response.status);
    return { body, httpStatus: response.status };
  }
}

/**
 * `fixtures/kma/` 스냅샷 리플레이 (`KMA_MODE=fixture`).
 *
 * ⚠️ **격자 · 구역 · 발표분과 무관하게 같은 응답을 준다.** 스냅샷이 오퍼레이션당 하나뿐이다.
 *    스냅샷은 2026.08.26 강릉 격자(92 · 131) · 강원영동(`11D20000`)이고 예보 날짜도
 *    그때 그대로다. 파이프라인 배선을 확인하는 용도이지 특정 날짜의 강수확률을 검증하는
 *    용도가 아니다 — 값 검증은 규칙 단위 테스트가 한다.
 */
export class FixtureKmaTransport implements KmaTransport {
  readonly kind = 'fixture' as const;

  constructor(private readonly fixtureDir: string) {}

  // 파일 읽기는 동기지만 인터페이스는 실호출과 같아야 한다
  async request(
    operation: KmaOperation,
    params: Readonly<Record<string, string | number>>,
  ): Promise<KmaTransportResult> {
    const file = join(this.fixtureDir, fixtureFile(operation, params));
    if (!existsSync(file)) throw new ForecastProviderError(`픽스처가 없다: ${file}`);
    return { body: readFileSync(file, 'utf8'), httpStatus: null };
  }
}

/**
 * 중기는 발표 시각마다 덮는 범위가 달라 발표분별 스냅샷을 나눠 둔다 (EI-WX-003).
 * 06시 발표에는 `rnSt4*` 가 있고 18시 발표에는 없다 — 그 차이가 리플레이에서도 살아야 한다.
 */
function fixtureFile(operation: KmaOperation, params: Readonly<Record<string, string | number>>): string {
  if (operation === 'getVilageFcst') return 'vilage_fcst.json';
  return String(params.tmFc ?? '').endsWith('1800') ? 'mid_land_1800.json' : 'mid_land_0600.json';
}

/** 환경변수 하나로 실호출 ↔ 리플레이를 고른다. 운영에서 리플레이는 거부한다 (FR-OP-009) */
export function createKmaTransport(env: NodeJS.ProcessEnv = process.env): KmaTransport {
  if (env.KMA_MODE === 'fixture') {
    if (env.NODE_ENV === 'production') {
      throw new Error('KMA_MODE=fixture 는 운영에서 쓸 수 없다 (FR-OP-009)');
    }
    return new FixtureKmaTransport(env.KMA_FIXTURE_DIR ?? resolve(process.cwd(), '../../fixtures/kma'));
  }
  return new HttpKmaTransport(env.KMA_SERVICE_KEY ?? '');
}

// ── 조회 결과 ─────────────────────────────────────────────────────────

export interface ShortTermForecast {
  /** 응답이 실제로 돌려준 발표분. 요청한 것과 같은지 클라이언트가 확인한다 */
  readonly baseDate: string;
  readonly baseTime: string;
  /** `YYYY-MM-DD` → (`HHmm` → 강수확률 0~1). 예보가 없는 날짜는 **키 자체가 없다** */
  readonly pop: ReadonlyMap<IsoDate, ReadonlyMap<string, number>>;
}

export interface MidLandForecast {
  readonly tmFc: string;
  /** `YYYY-MM-DD` → 강수확률 0~1. 오전 · 오후 중 큰 값 (EI-WX-003) */
  readonly byDate: ReadonlyMap<IsoDate, number>;
}

export interface KmaClientOptions {
  readonly transport: KmaTransport;
  readonly logger: ApiCallLogger;
  readonly clock?: () => Date;
  readonly auditRunId?: number | null;
}

export class KmaClient {
  private readonly transport: KmaTransport;
  private readonly logger: ApiCallLogger;
  private readonly clock: () => Date;
  private readonly auditRunId: number | null;

  constructor(options: KmaClientOptions) {
    this.transport = options.transport;
    this.logger = options.logger;
    this.clock = options.clock ?? ((): Date => new Date());
    this.auditRunId = options.auditRunId ?? null;
  }

  /**
   * 단기예보 강수확률 (EI-WX-002).
   *
   * 격자 하나로만 부른다 — 일정 항목마다 부르지 않는다. 5km 격자라 같은 도시 안
   * 관광지는 대개 같은 격자에 떨어지고, 항목별로 부르면 호출만 늘고 답은 같다.
   */
  async shortTermPop(grid: GridPoint, publication: ShortPublication): Promise<ShortTermForecast> {
    const items = await this.call('getVilageFcst', {
      pageNo: 1,
      // 한 발표분이 900건 안팎이다(2026.08.26 실측 907건). 나눠 받으면 호출만 늘어난다
      numOfRows: 1000,
      base_date: publication.baseDate,
      base_time: publication.baseTime,
      nx: grid.nx,
      ny: grid.ny,
    });
    return readShortTerm(items, publication, this.transport.kind);
  }

  /**
   * 중기육상예보 강수확률 (EI-WX-003).
   *
   * **발표 시각이 지난 발표분만 넘겨야 한다** (EI-WX-008). 발표 전 `tmFc` 를 물으면
   * 이전 발표분 값이 오류 없이 오고, 응답에 `tmFc` 가 없어서 구분할 방법이 없다.
   * 그 판단은 `chooseMidPublication` 이 한다.
   *
   * `regId` 는 광역 구역 10종만 받는다. 세부 구역 코드를 넣으면 오류가 아니라 **강수확률
   * 0% 가 조용히** 온다 — 타입으로 막고 응답에서 한 번 더 본다 (`readMidLand`).
   */
  async midLandRain(regId: MidLandRegionId, publication: MidPublication): Promise<MidLandForecast> {
    const items = await this.call('getMidLandFcst', {
      pageNo: 1,
      numOfRows: 10,
      regId,
      tmFc: publication.tmFc,
    });
    return readMidLand(items, publication);
  }

  /**
   * 호출하고 **봉투까지 열어서** 돌려준다.
   *
   * 봉투를 호출자가 열게 두면 안 된다 — `NO_DATA` 는 HTTP 200 으로 오므로 전송만 보고
   * 로그를 남기면 실패한 조회가 `OK` 로 기록된다. 증빙 로그가 그러면 쓸모가 없다
   * (FR-OP-001).
   */
  private async call(
    operation: KmaOperation,
    params: Readonly<Record<string, string | number>>,
  ): Promise<readonly Record<string, unknown>[]> {
    const startedAt = this.clock();
    let status: CallStatus = 'FAIL';
    let httpStatus: number | null = null;
    let resultCode: string | null = null;

    try {
      const res = await this.transport.request(operation, params);
      httpStatus = res.httpStatus;
      resultCode = readResultCode(res.body);
      const items = readItems(res.body);
      status = 'OK';
      return items;
    } catch (e) {
      if (e instanceof ForecastProviderError) {
        httpStatus = e.httpStatus ?? httpStatus;
        resultCode = e.resultCode ?? resultCode;
        if (e.message.includes('TIMEOUT')) status = 'TIMEOUT';
      }
      if (e instanceof ForecastMissingError) resultCode = e.resultCode ?? resultCode;
      throw e;
    } finally {
      this.record(operation, startedAt, status, httpStatus, resultCode);
    }
  }

  private record(
    operation: KmaOperation,
    startedAt: Date,
    status: CallStatus,
    httpStatus: number | null,
    resultCode: string | null,
  ): void {
    const entry: ApiCallLogEntry = {
      provider: 'KMA',
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

// ── 응답 해석 ─────────────────────────────────────────────────────────

/**
 * 봉투를 열고 항목 배열을 꺼낸다.
 *
 * 공사와 같은 data.go.kr 이라 게이트웨이 오류가 **XML** 로 오는 것도 같다. 다른 것은
 * 정상 `resultCode` 다 — 공사는 `0000`, 기상청은 `00` 이다. 공사 봉투 파서를 그대로
 * 쓰면 정상 응답을 전부 실패로 읽는다.
 *
 * 응답 본문을 오류 메시지에 담지 않는다 (DB 명세서 6-4 누출 경로 ①).
 */
export function readItems(body: string): readonly Record<string, unknown>[] {
  const trimmed = body.trimStart();
  if (trimmed.startsWith('<')) {
    const detail = matchTag(trimmed, 'returnAuthMsg') ?? matchTag(trimmed, 'errMsg') ?? 'XML 오류 응답';
    throw new ForecastProviderError(`게이트웨이 오류: ${detail}`, null, matchTag(trimmed, 'returnReasonCode'));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ForecastProviderError('JSON 으로 해석할 수 없는 응답');
  }

  const response = pick(parsed, 'response');
  const header = pick(response, 'header');
  if (!isRecord(header)) throw new ForecastProviderError('응답에 header 가 없다');

  const resultCode = String(header.resultCode ?? '');
  const resultMsg = String(header.resultMsg ?? '');
  if (resultCode === RESULT_NO_DATA || resultCode === RESULT_OUT_OF_RANGE) {
    throw new ForecastMissingError(`resultCode ${resultCode}: ${resultMsg}`, resultCode);
  }
  if (resultCode !== RESULT_OK) {
    throw new ForecastProviderError(`resultCode ${resultCode}: ${resultMsg}`, null, resultCode);
  }

  const item = pick(pick(pick(response, 'body'), 'items'), 'item');
  if (Array.isArray(item)) return item.filter(isRecord);
  if (isRecord(item)) return [item];
  // 0건도 예보 없음이다. 빈 배열을 돌려주면 호출자가 강수확률 0 으로 읽을 여지가 생긴다
  throw new ForecastMissingError('응답에 항목이 없다');
}

function readResultCode(body: string): string | null {
  const trimmed = body.trimStart();
  if (trimmed.startsWith('<')) return matchTag(trimmed, 'returnReasonCode');
  try {
    const header = pick(pick(JSON.parse(trimmed), 'response'), 'header');
    return isRecord(header) ? String(header.resultCode ?? '') || null : null;
  } catch {
    return null;
  }
}

/**
 * 단기예보 항목에서 `POP` 만 골라 날짜 · 시각별로 정리한다.
 *
 * **받은 발표분이 요청한 발표분과 같은지 확인한다** (EI-WX-008). 단기는 항목마다
 * `baseDate` · `baseTime` 을 돌려주므로 확인할 수 있다 — 중기에는 그 수단이 없다.
 * 리플레이는 스냅샷 하나를 고정으로 돌려주므로 이 확인을 건너뛴다.
 */
export function readShortTerm(
  items: readonly Record<string, unknown>[],
  requested: ShortPublication,
  transportKind: 'http' | 'fixture' = 'http',
): ShortTermForecast {
  const first = items[0] as { baseDate?: unknown; baseTime?: unknown } | undefined;
  const baseDate = String(first?.baseDate ?? '');
  const baseTime = String(first?.baseTime ?? '');

  if (transportKind === 'http' && (baseDate !== requested.baseDate || baseTime !== requested.baseTime)) {
    throw new ForecastProviderError(
      `요청한 발표분과 다른 응답이다 (요청 ${requested.baseDate} ${requested.baseTime} · 응답 ${baseDate} ${baseTime})`,
    );
  }

  const pop = new Map<IsoDate, Map<string, number>>();
  for (const item of items) {
    if (item.category !== POP_CATEGORY) continue;
    const date = toIsoDate(item.fcstDate);
    const time = typeof item.fcstTime === 'string' ? item.fcstTime : String(item.fcstTime ?? '');
    const ratio = toRatio(item.fcstValue);
    if (date === null || time === '' || ratio === null) continue;
    const slots = pop.get(date) ?? new Map<string, number>();
    slots.set(time, ratio);
    pop.set(date, slots);
  }

  if (pop.size === 0) throw new ForecastMissingError('응답에 POP 항목이 없다');
  return { baseDate, baseTime, pop };
}

/**
 * 중기육상예보 항목에서 날짜별 강수확률을 뽑는다.
 *
 * ⚠️ **없는 필드를 0 으로 읽지 않는다.** 그것이 이 어댑터가 막는 가장 큰 사고다 —
 *    `rnSt4Am` 이 없는 18시 발표분에서 D+4 를 0% 로 읽으면 비 오는 날이 정상 판정된다.
 *    값이 없는 날짜는 `byDate` 에 키가 아예 없고, 호출자는 확인 불가로 옮긴다.
 *
 * +8일부터는 오전 · 오후 구분 없이 `rnSt8` 처럼 한 값이다 (EI-WX-003).
 */
export function readMidLand(
  items: readonly Record<string, unknown>[],
  publication: MidPublication,
): MidLandForecast {
  const item = (items[0] ?? {}) as Record<string, unknown>;
  const range = MID_OFFSET_RANGE[publication.hour];

  /*
   * 광역 구역이 아닌 코드를 넣으면 `NO_DATA` 가 아니라 **`00 NORMAL_SERVICE` 에 전 필드 0**
   * 이 온다 (2026.08.26 실측 — `regId=11D20301` 은 중기기온 지점 코드다). 그대로 읽으면
   * 강수확률 0% 라 비 오는 날이 전부 정상 판정된다. 아무 데도 없는 코드(`ZZZZZZZZ`)는
   * `NO_DATA` 로 제대로 떨어지므로, 위험한 것은 **존재하지만 육상 구역이 아닌** 코드다.
   *
   * 실제 예보에는 `wf*` 에 날씨 문자열이 있다. 하나도 없으면 예보구역으로 인식되지 않은 것이다.
   * 판정에는 쓰지 않고 응답이 진짜인지 보는 데만 쓴다 (EI-WX-003 — 판정은 강수확률만).
   */
  if (!hasAnyWeatherText(item)) {
    throw new ForecastMissingError('예보구역으로 인식되지 않은 응답 (전 항목이 빈 값)');
  }

  const byDate = new Map<IsoDate, number>();
  for (let offset = range.from; offset <= range.to; offset++) {
    const values = offset >= 8
      ? [item[`rnSt${offset}`]]
      : [item[`rnSt${offset}Am`], item[`rnSt${offset}Pm`]];

    const ratios = values.map(toRatio).filter((v): v is number => v !== null);
    if (ratios.length === 0) continue;

    const date = midTargetDate(publication, offset);
    if (date === null) continue;
    // 오전 · 오후 중 큰 값 (EI-WX-003)
    byDate.set(date, Math.max(...ratios));
  }

  if (byDate.size === 0) throw new ForecastMissingError('응답에 rnSt 항목이 없다');
  return { tmFc: publication.tmFc, byDate };
}

/** `wf*` 중 하나라도 날씨 문자열이 있는가 */
function hasAnyWeatherText(item: Record<string, unknown>): boolean {
  return Object.entries(item).some(([k, v]) => k.startsWith('wf') && typeof v === 'string' && v.trim() !== '');
}

/** 기상청은 강수확률을 정수 퍼센트로 준다. 판정 임계치가 비율이라 여기서 맞춘다 */
function toRatio(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n / 100;
}

function toIsoDate(value: unknown): IsoDate | null {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  if (!/^\d{8}$/.test(raw)) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function matchTag(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>\\s*([^<]*)\\s*</${tag}>`, 'i').exec(xml);
  return m?.[1]?.trim() || null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pick(v: unknown, key: string): unknown {
  return isRecord(v) ? v[key] : undefined;
}
