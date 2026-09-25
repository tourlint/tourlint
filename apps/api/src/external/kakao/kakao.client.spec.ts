import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryApiCallLogger } from '../api-call-log';
import {
  FixtureKakaoTransport, KakaoMobilityClient, readSummary,
  type KakaoTransport, type KakaoTransportResult,
} from './kakao.client';
import { RouteNotFoundError, RouteProviderError } from './kakao.errors';

/**
 * 어댑터 테스트는 어댑터 쪽에 둔다. 규칙 스펙에 두면 `engine/rules` 가 `external` 을
 * import 하게 되고, 그건 eslint 가 막는 경계다 (NF-MT-003).
 */
const FIXTURES = join(__dirname, '../../../../../fixtures/kakao');
const body = (file: string): string => readFileSync(join(FIXTURES, file), 'utf8');

/** 실호출 자리를 대신한다. 리플레이와 달리 호출 로그를 남겨야 한다 */
class StubTransport implements KakaoTransport {
  readonly kind = 'http' as const;
  constructor(private readonly file: string) {}
  async request(): Promise<KakaoTransportResult> {
    return { body: body(this.file), httpStatus: 200 };
  }
}

describe('응답 해석 (EI-KM-004 · 005)', () => {
  it('실호출 스냅샷에서 거리·시간을 꺼낸다', () => {
    const s = readSummary(body('future_directions.json'));
    expect(s.resultCode).toBe(0);
    expect(s.distanceMeters).toBeGreaterThan(0);
    expect(s.durationSeconds).toBeGreaterThan(0);
  });

  it('HTTP 200 이어도 result_code 가 0 이 아니면 실패다', () => {
    // 넘기면 "이동시간 0분" 으로 둔갑한다
    const failed = JSON.stringify({ routes: [{ result_code: 104, result_msg: '출발지와 도착지가 5m 이내' }] });
    expect(() => readSummary(failed)).toThrow(RouteNotFoundError);
  });

  it('요금 정보를 읽지 않는다', () => {
    const s = readSummary(body('directions.json'));
    expect(Object.keys(s)).toEqual(['resultCode', 'distanceMeters', 'durationSeconds']);
  });

  it('리플레이로 경로를 얻는다', async () => {
    const client = new KakaoMobilityClient({
      transport: new FixtureKakaoTransport(FIXTURES),
      logger: new InMemoryApiCallLogger(),
    });
    const r = await client.route({ x: 128.8961, y: 37.7952 }, { x: 128.8796, y: 37.7791 }, '202610221200');
    expect(r.futureBased).toBe(true);
    expect(r.distanceMeters).toBeGreaterThan(0);
  });

  it('호출 로그를 남긴다 (FR-OP-001)', async () => {
    const logger = new InMemoryApiCallLogger();
    await new KakaoMobilityClient({ transport: new StubTransport('directions.json'), logger })
      .route({ x: 1, y: 1 }, { x: 2, y: 2 }, null);
    expect(logger.entries[0]).toMatchObject({ provider: 'KAKAO_MOBILITY', operation: 'directions', status: 'OK' });
  });

  it('리플레이는 남기지 않는다 — 안 한 호출이 증빙에 섞이면 안 된다 (FR-OP-007)', async () => {
    const logger = new InMemoryApiCallLogger();
    await new KakaoMobilityClient({ transport: new FixtureKakaoTransport(FIXTURES), logger })
      .route({ x: 1, y: 1 }, { x: 2, y: 2 }, null);
    expect(logger.entries).toEqual([]);
  });
});


describe('인증키가 새지 않는다 (EI-CM-002 · NF-SC-009)', () => {
  it('네트워크 오류 메시지에 키가 없다', async () => {
    const { HttpKakaoTransport } = await import('./kakao.client');
    const KEY = 'SUPER-SECRET-KAKAO-KEY';
    const t = new HttpKakaoTransport(KEY, {
      fetchImpl: async () => { throw new TypeError('fetch failed'); },
    });
    const e = await t.request('directions', { origin: '1,1' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RouteProviderError);
    expect(JSON.stringify({ m: (e as Error).message, s: (e as Error).stack })).not.toContain(KEY);
  });

  it('키가 비어 있으면 생성 단계에서 막는다', async () => {
    const { HttpKakaoTransport } = await import('./kakao.client');
    expect(() => new HttpKakaoTransport('')).toThrow(/인증키|키가 비어/);
  });
});

/*
 * 일시 장애는 지수 백오프로 2회 더 부른다 (EI-CM-005 · EX-EI-022 · #795). 전에는 한 번 실패하면
 * 그 구간이 바로 확인 불가(−3)였다. 인증 · 요청 오류와 경로 없음은 다시 불러도 같다.
 */
describe('일시 장애는 다시 부른다 (EI-CM-005 · EX-EI-022 · #795)', () => {
  /** 호출마다 대본대로 답한다. 대본이 끝나면 마지막 줄을 되풀이한다 */
  class ScriptTransport implements KakaoTransport {
    readonly kind = 'http' as const;
    readonly calls: string[] = [];
    constructor(private readonly script: readonly (Error | string)[]) {}
    async request(operation: string): Promise<KakaoTransportResult> {
      this.calls.push(operation);
      const next = this.script[Math.min(this.calls.length, this.script.length) - 1];
      if (next instanceof Error) throw next;
      return { body: next ?? '', httpStatus: 200 };
    }
  }
  const A = { x: 128.8961, y: 37.7954 };
  const B = { x: 128.8785, y: 37.7791 };
  const client = (t: KakaoTransport, waits: number[] = [], log = new InMemoryApiCallLogger()): KakaoMobilityClient =>
    new KakaoMobilityClient({ transport: t, logger: log, baseDelayMs: 100, sleep: async (ms) => { waits.push(ms); } });

  it('🔴 5xx · 응답 없음은 2회 더 부르고, 셋째에 성공하면 그 값을 쓴다 — 시도마다 기록 1행', async () => {
    const t = new ScriptTransport([new RouteProviderError('HTTP 502', 502), new RouteProviderError('TIMEOUT'), body('directions.json')]);
    const waits: number[] = [];
    const log = new InMemoryApiCallLogger();
    const route = await client(t, waits, log).route(A, B, null);
    expect(route.durationSeconds).toBeGreaterThan(0);
    expect(t.calls).toEqual(['directions', 'directions', 'directions']);
    expect(waits).toEqual([100, 200]);
    expect(log.entries.map((e) => e.status)).toEqual(['FAIL', 'FAIL', 'OK']);
  });

  it('🔴 세 번 다 실패하면 ROUTE_PROVIDER_FAILED 로 끝낸다 — 그 이상 부르지 않는다', async () => {
    const t = new ScriptTransport([new RouteProviderError('HTTP 503', 503)]);
    await expect(client(t).route(A, B, null)).rejects.toBeInstanceOf(RouteProviderError);
    expect(t.calls).toHaveLength(3);
  });

  it('429 는 다시 부른다 — 잠깐 몰린 것이다', async () => {
    const t = new ScriptTransport([new RouteProviderError('HTTP 429', 429), body('directions.json')]);
    await expect(client(t).route(A, B, null)).resolves.toMatchObject({ futureBased: false });
    expect(t.calls).toHaveLength(2);
  });

  it('4xx(인증 · 요청 오류)는 다시 부르지 않는다 — 다시 불러도 같다', async () => {
    const t = new ScriptTransport([new RouteProviderError('HTTP 401', 401)]);
    await expect(client(t).route(A, B, null)).rejects.toBeInstanceOf(RouteProviderError);
    expect(t.calls).toHaveLength(1);
  });

  it('경로 없음(result_code ≠ 0)은 다시 부르지 않는다', async () => {
    const t = new ScriptTransport([JSON.stringify({ routes: [{ result_code: 104, result_msg: '출발지와 도착지가 5m 이내' }] })]);
    await expect(client(t).route(A, B, null)).rejects.toBeInstanceOf(RouteNotFoundError);
    expect(t.calls).toHaveLength(1);
  });

  it('미래 운행 정보는 한 번만 부르고 현재 시각 기준으로 넘어간다 (EX-EI-020)', async () => {
    const t = new ScriptTransport([new RouteProviderError('HTTP 503', 503), body('directions.json')]);
    const route = await client(t).route(A, B, '202611171000');
    expect(t.calls).toEqual(['future/directions', 'directions']);
    expect(route.futureBased).toBe(false);
  });
});
