import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryApiCallLogger } from '../api-call-log';
import { FixtureKakaoTransport, KakaoMobilityClient, readSummary } from './kakao.client';
import { RouteNotFoundError, RouteProviderError } from './kakao.errors';

/**
 * 어댑터 테스트는 어댑터 쪽에 둔다. 규칙 스펙에 두면 `engine/rules` 가 `external` 을
 * import 하게 되고, 그건 eslint 가 막는 경계다 (NF-MT-003).
 */
const FIXTURES = join(__dirname, '../../../../../fixtures/kakao');
const body = (file: string): string => readFileSync(join(FIXTURES, file), 'utf8');

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
    await new KakaoMobilityClient({ transport: new FixtureKakaoTransport(FIXTURES), logger })
      .route({ x: 1, y: 1 }, { x: 2, y: 2 }, null);
    expect(logger.entries[0]).toMatchObject({ provider: 'KAKAO_MOBILITY', operation: 'directions', status: 'OK' });
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
