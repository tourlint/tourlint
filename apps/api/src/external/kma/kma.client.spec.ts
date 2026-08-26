import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryApiCallLogger } from '../api-call-log';
import {
  FixtureKmaTransport, HttpKmaTransport, KmaClient, createKmaTransport,
  readItems, readMidLand, readShortTerm,
  type KmaOperation, type KmaTransport,
} from './kma.client';
import { ForecastMissingError, ForecastProviderError } from './kma.errors';
import type { MidPublication, ShortPublication } from './publication';

const FIXTURES = resolve(__dirname, '../../../../../fixtures/kma');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
/** 봉투를 연 뒤의 항목 배열. 해석 함수들은 여기서부터 받는다 */
const items = (name: string): readonly Record<string, unknown>[] => readItems(fixture(name));

/** 스냅샷을 뜬 발표분 — 픽스처가 그 시점 그대로다 */
const SHORT_PUB: ShortPublication = { baseDate: '20260826', baseTime: '0500' };
const MID_0600: MidPublication = { tmFc: '202608260600', baseDate: '2026-08-26', hour: 6 };
const MID_1800: MidPublication = { tmFc: '202608261800', baseDate: '2026-08-26', hour: 18 };

class StubTransport implements KmaTransport {
  readonly kind = 'fixture' as const;
  readonly calls: { operation: KmaOperation; params: Record<string, string | number> }[] = [];
  constructor(private readonly body: string | Error) {}
  async request(operation: KmaOperation, params: Record<string, string | number>): Promise<{ body: string; httpStatus: null }> {
    this.calls.push({ operation, params });
    if (this.body instanceof Error) throw this.body;
    return { body: this.body, httpStatus: null };
  }
}

describe('기상청 어댑터 (EI-WX-001 ~ 008)', () => {
  describe('봉투 해석', () => {
    it('정상 resultCode 는 0000 이 아니라 00 이다', () => {
      // 공사 봉투 파서를 그대로 쓰면 정상 응답을 전부 실패로 읽는다
      expect(readItems(fixture('mid_land_0600.json'))).toHaveLength(1);
    });

    it('NO_DATA(03) 는 재시도 대상이 아니다', () => {
      try {
        readItems(fixture('mid_land_no_data.json'));
        expect.unreachable('던져야 한다');
      } catch (e) {
        expect(e).toBeInstanceOf(ForecastMissingError);
        expect((e as ForecastMissingError).retryable).toBe(false);
        expect((e as ForecastMissingError).reasonCode).toBe('FORECAST_UNAVAILABLE');
      }
    });

    it('조회 기간 초과(99) 도 발표분 없음이다', () => {
      const body = '{"response":{"header":{"resultCode":"99","resultMsg":"최대 조회 기간은 오늘 기준으로 1일 전까지입니다."}}}';
      expect(() => readItems(body)).toThrow(ForecastMissingError);
    });

    it('게이트웨이 XML 오류는 제공자 오류다', () => {
      const xml = '<OpenAPI_ServiceResponse><cmmMsgHeader><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>';
      try {
        readItems(xml);
        expect.unreachable('던져야 한다');
      } catch (e) {
        expect(e).toBeInstanceOf(ForecastProviderError);
        expect((e as ForecastProviderError).resultCode).toBe('30');
      }
    });

    it('오류 메시지에 응답 본문을 담지 않는다 (DB 명세서 6-4)', () => {
      const body = '{"response":{"header":{"resultCode":"03","resultMsg":"NO_DATA"},"body":{"items":{"item":[{"비밀":"값"}]}}}}';
      expect(() => readItems(body)).toThrow(/^기상청 예보가 없다: resultCode 03: NO_DATA$/);
    });
  });

  describe('단기예보 (EI-WX-002)', () => {
    it('POP 만 뽑는다 — 기온 · 하늘상태는 읽지 않는다', () => {
      const f = readShortTerm(items('vilage_fcst.json'), SHORT_PUB);
      expect(f.baseDate).toBe('20260826');
      expect(f.baseTime).toBe('0500');
      // 실측 스냅샷: 08-26 18건 · 08-27 24 · 08-28 24 · 08-29 8 · 08-30 1
      expect(f.pop.get('2026-08-26')?.size).toBe(18);
      expect(f.pop.get('2026-08-29')?.size).toBe(8);
    });

    it('강수확률을 퍼센트가 아니라 비율로 준다', () => {
      const f = readShortTerm(items('vilage_fcst.json'), SHORT_PUB);
      for (const slots of f.pop.values()) {
        for (const v of slots.values()) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    });

    it('D+3 커버리지는 21시에서 끝난다 (2026.08.26 실측)', () => {
      const f = readShortTerm(items('vilage_fcst.json'), SHORT_PUB);
      const d3 = f.pop.get('2026-08-29');
      expect(d3?.has('2100')).toBe(true);
      // 22시 이후 야외 일정은 이 발표분으로 판정할 수 없다 (FR-RU-091)
      expect(d3?.has('2200')).toBe(false);
      expect(d3?.has('2300')).toBe(false);
    });

    it('🔴 다른 발표분이 오면 던진다 — 항목의 baseDate · baseTime 으로 확인한다 (EI-WX-008)', () => {
      expect(() => readShortTerm(items('vilage_fcst.json'), { baseDate: '20260826', baseTime: '1400' }))
        .toThrow(ForecastProviderError);
    });

    it('리플레이는 스냅샷 하나를 고정으로 주므로 그 확인을 건너뛴다', () => {
      const f = readShortTerm(items('vilage_fcst.json'), { baseDate: '20260826', baseTime: '1400' }, 'fixture');
      expect(f.baseTime).toBe('0500');
    });

    it('POP 이 하나도 없으면 0% 가 아니라 발표분 없음이다', () => {
      const body = '{"response":{"header":{"resultCode":"00","resultMsg":"NORMAL_SERVICE"},"body":{"items":{"item":[{"baseDate":"20260826","baseTime":"0500","category":"TMP","fcstDate":"20260826","fcstTime":"0600","fcstValue":"24"}]}}}}';
      expect(() => readShortTerm(readItems(body), SHORT_PUB)).toThrow(ForecastMissingError);
    });
  });

  describe('중기육상예보 (EI-WX-003)', () => {
    it('06시 발표는 D+4 부터 준다', () => {
      const f = readMidLand(items('mid_land_0600.json'), MID_0600);
      expect([...f.byDate.keys()]).toEqual([
        '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02',
        '2026-09-03', '2026-09-04', '2026-09-05',
      ]);
      expect(f.byDate.get('2026-08-30')).toBeCloseTo(0.6);
    });

    it('🔴 18시 발표에 없는 D+4 를 0% 로 읽지 않는다', () => {
      const f = readMidLand(items('mid_land_1800.json'), MID_1800);
      // 발표일 +4 는 08-30 이다. 키가 없어야 하고 0 이면 안 된다
      expect(f.byDate.has('2026-08-30')).toBe(false);
      expect(f.byDate.get('2026-08-30')).toBeUndefined();
      expect(f.byDate.has('2026-08-31')).toBe(true);
    });

    it('오전 · 오후 중 큰 값을 취한다', () => {
      // 실측 스냅샷 08-26 06시: rnSt4Am=60 rnSt4Pm=20
      const f = readMidLand(items('mid_land_0600.json'), MID_0600);
      expect(f.byDate.get('2026-08-30')).toBeCloseTo(0.6);
    });

    it('+8일부터는 오전 · 오후 구분 없이 한 값이다', () => {
      const f = readMidLand(items('mid_land_1800.json'), MID_1800);
      // 18시 발표 기준 +8 = 09-03
      expect(f.byDate.has('2026-09-03')).toBe(true);
      expect(f.byDate.has('2026-09-05')).toBe(true);
    });

    it('rnSt 가 하나도 없으면 발표분 없음이다', () => {
      const body = '{"response":{"header":{"resultCode":"00","resultMsg":"NORMAL_SERVICE"},"body":{"items":{"item":[{"regId":"11D20000","wf4Am":"흐리고 비"}]}}}}';
      expect(() => readMidLand(readItems(body), MID_0600)).toThrow(ForecastMissingError);
    });
  });

  describe('클라이언트', () => {
    it('호출을 로그에 남긴다 (EI-CM-006 · FR-OP-001)', async () => {
      const logger = new InMemoryApiCallLogger();
      const client = new KmaClient({ transport: new StubTransport(fixture('mid_land_0600.json')), logger, auditRunId: 7 });

      await client.midLandRain('11D20000', MID_0600);

      expect(logger.entries).toHaveLength(1);
      const [entry] = logger.entries;
      expect(entry?.provider).toBe('KMA');
      expect(entry?.operation).toBe('getMidLandFcst');
      expect(entry?.status).toBe('OK');
      expect(entry?.resultCode).toBe('00');
      expect(entry?.auditRunId).toBe(7);
    });

    it('실패한 호출도 로그에 남는다', async () => {
      const logger = new InMemoryApiCallLogger();
      const client = new KmaClient({ transport: new StubTransport(fixture('mid_land_no_data.json')), logger });

      await expect(client.midLandRain('11D20000', MID_0600)).rejects.toThrow(ForecastMissingError);
      expect(logger.entries[0]?.status).toBe('FAIL');
      expect(logger.entries[0]?.resultCode).toBe('03');
    });

    it('타임아웃은 FAIL 이 아니라 TIMEOUT 으로 남는다', async () => {
      const logger = new InMemoryApiCallLogger();
      const client = new KmaClient({ transport: new StubTransport(new ForecastProviderError('TIMEOUT')), logger });

      await expect(client.midLandRain('11D20000', MID_0600)).rejects.toThrow(ForecastProviderError);
      expect(logger.entries[0]?.status).toBe('TIMEOUT');
    });

    it('격자 하나로만 부른다 — 일정 항목마다 부르지 않는다 (EI-WX-002)', async () => {
      const transport = new StubTransport(fixture('vilage_fcst.json'));
      const client = new KmaClient({ transport, logger: new InMemoryApiCallLogger() });

      await client.shortTermPop({ nx: 92, ny: 131 }, SHORT_PUB);

      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0]?.params).toMatchObject({ nx: 92, ny: 131, base_date: '20260826', base_time: '0500' });
    });
  });

  describe('리플레이 (FR-OP-009)', () => {
    it('발표 시각별로 다른 스냅샷을 준다 — 06시에는 rnSt4 가 있다', async () => {
      const transport = new FixtureKmaTransport(FIXTURES);
      const at0600 = await transport.request('getMidLandFcst', { tmFc: '202608260600' });
      const at1800 = await transport.request('getMidLandFcst', { tmFc: '202608261800' });

      expect(at0600.body).toContain('rnSt4Am');
      expect(at1800.body).not.toContain('rnSt4Am');
    });

    it('없는 픽스처는 조용히 대체하지 않는다', async () => {
      const transport = new FixtureKmaTransport('/없는/경로');
      await expect(transport.request('getVilageFcst', {})).rejects.toThrow(ForecastProviderError);
    });

    it('운영에서는 리플레이를 거부한다', () => {
      expect(() => createKmaTransport({ KMA_MODE: 'fixture', NODE_ENV: 'production' })).toThrow(/FR-OP-009/);
    });

    it('KMA_MODE 가 없으면 실호출 어댑터다', () => {
      expect(createKmaTransport({ KMA_SERVICE_KEY: 'x' }).kind).toBe('http');
    });

    it('인증키가 비면 만들 때 바로 던진다', () => {
      expect(() => new HttpKmaTransport('')).toThrow(/KMA_SERVICE_KEY/);
    });
  });
});
