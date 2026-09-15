import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryApiCallLogger } from '../api-call-log';
import { KTO_MAX_ROWS, KTO_VISITOR_ROWS, KtoClient } from './kto.client';
import {
  ContentNotFoundError,
  KtoAuthError,
  KtoFetchError,
  KtoInvalidRequestError,
  KtoQuotaExceededError,
  KtoTimeoutError,
} from './kto.errors';
import { FixtureKtoTransport, type KtoParams, type KtoTransport, type KtoTransportResult } from './transport';

const FIXTURES = join(__dirname, '../../../../../fixtures/kto');

/** 호출 순서·파라미터를 관찰하고 정해진 응답을 돌려주는 트랜스포트 */
class StubTransport implements KtoTransport {
  readonly kind = 'http' as const;
  readonly calls: { operation: string; params: KtoParams }[] = [];
  constructor(private readonly responses: (string | Error)[]) {}

  async request(operation: string, params: KtoParams): Promise<KtoTransportResult> {
    this.calls.push({ operation, params });
    const next = this.responses[Math.min(this.calls.length - 1, this.responses.length - 1)];
    if (next instanceof Error) throw next;
    return { body: next ?? '{}', httpStatus: 200 };
  }
}

const ok = (body: Record<string, unknown>): string =>
  JSON.stringify({ response: { header: { resultCode: '0000', resultMsg: 'OK' }, body } });

/** 호출마다 1ms 씩 흐르는 결정론적 시계 — 실제 대기 없이 소요시간을 관찰한다 */
function fakeClock(startMs = Date.parse('2026-08-22T01:00:00Z')): () => Date {
  let t = startMs;
  return () => new Date((t += 1));
}

describe('KtoClient', () => {
  let logger: InMemoryApiCallLogger;
  const noSleep = async (): Promise<void> => undefined;

  beforeEach(() => {
    logger = new InMemoryApiCallLogger();
  });

  const client = (transport: KtoTransport, extra: Record<string, unknown> = {}): KtoClient =>
    new KtoClient({ transport, logger, sleep: noSleep, clock: fakeClock(), ...extra });

  describe('오퍼레이션 5종', () => {
    const fixture = new FixtureKtoTransport(FIXTURES);

    it('searchKeyword — 목록과 페이지 정보를 돌려준다', async () => {
      const page = await client(fixture).searchKeyword({ keyword: '강릉' });
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.totalCount).toBeGreaterThan(0);
    });

    it('detailCommon — 항목 1건을 돌려준다', async () => {
      const ids = fixture.availableContentIds('detailCommon2');
      const item = await client(fixture).detailCommon(ids[0] ?? '');
      expect(item.contentid).toBe(ids[0]);
    });

    it('detailIntro — 운영시간·휴무일 원문이 들어 있다', async () => {
      const item = await client(fixture).detailIntro('125769', 12);
      expect(item).toHaveProperty('restdate');
      expect(item).toHaveProperty('usetime');
    });

    it('searchFestival — 행사 목록을 돌려준다', async () => {
      const page = await client(fixture).searchFestival({ eventStartDate: '20261022' });
      expect(page.items.length).toBeGreaterThan(0);
    });

    it('locationBasedList — 좌표 기반 목록을 돌려준다', async () => {
      const page = await client(fixture).locationBasedList({ mapX: 128.8, mapY: 37.79, radius: 5000 });
      expect(page.items.length).toBeGreaterThan(0);
    });
  });

  describe('새 서비스 5종 — 픽스처 (EI-KT-022 ~ 026)', () => {
    const fixture = new FixtureKtoTransport(FIXTURES);
    const GANGNEUNG = { lDongRegnCd: '51', lDongSignguCd: '150' };

    it('withAreaBasedList — 목록의 contentid 가 국문 관광정보와 같다', async () => {
      const page = await client(fixture).withAreaBasedList(GANGNEUNG);
      // 오죽헌(129784)은 데모 상품의 국문 contentid 다
      expect(page.items.map((i) => i.contentid)).toContain('129784');
      expect(page.totalCount).toBe(page.items.length);
    });

    it('detailWithTour — 무장애 항목을 돌려준다', async () => {
      const item = await client(fixture).detailWithTour('129784');
      expect(item).toHaveProperty('wheelchair');
      expect(item).toHaveProperty('restroom');
    });

    it('petAreaBasedList · detailPetTour — 동반 조건을 돌려준다', async () => {
      const page = await client(fixture).petAreaBasedList(GANGNEUNG);
      expect(page.items.length).toBeGreaterThan(0);
      const item = await client(fixture).detailPetTour('2628994');
      expect(item).toHaveProperty('acmpyTypeCd');
      expect(item).toHaveProperty('acmpyPsblCpam');
    });

    it('relatedSearchKeyword — 순위는 오지만 국문 contentid 는 없다 (3-4)', async () => {
      const page = await client(fixture).relatedSearchKeyword({ keyword: '경포대', baseYm: '202608', areaCd: '51', signguCd: '51150' });
      expect(page.items.length).toBeGreaterThan(0);
      for (const i of page.items) {
        expect(i).toHaveProperty('rlteRank');
        expect(i).not.toHaveProperty('contentid');
      }
    });

    it('courseList — 전국 목록이고 좌표가 없다', async () => {
      const page = await client(fixture).courseList();
      expect(page.items.every((i) => /^T_CRS_MNG\d{10}$/.test(String(i.crsIdx)))).toBe(true);
      expect(page.items.some((i) => 'mapx' in i)).toBe(false);
    });

    it('locgoRegnVisitrDDList — 지역 코드는 법정동 시도 + 시군구 5자리다', async () => {
      const page = await client(fixture).locgoRegnVisitrDDList({ startYmd: '20250901', endYmd: '20250901' });
      expect(page.items.every((i) => /^\d{5}$/.test(String(i.signguCode)))).toBe(true);
      expect(page.items.filter((i) => i.signguCode === '51150')).toHaveLength(3); // 현지인 · 외지인 · 외국인
    });

    it('locationBasedList — 근처 3km 식당 · 숙소를 분류로 거른다', async () => {
      const near = { mapX: 128.8947280147, mapY: 37.7517436388, radius: 3000 };
      const food = await client(fixture).locationBasedList({ ...near, lclsSystm1: 'FD' });
      const lodging = await client(fixture).locationBasedList({ ...near, lclsSystm1: 'AC' });
      expect(food.items.every((i) => Number(i.dist) <= 3000)).toBe(true);
      expect(lodging.items.every((i) => i.lclsSystm1 === 'AC')).toBe(true);
    });
  });

  describe('새 서비스 파라미터 계약', () => {
    const region = { lDongRegnCd: '51', lDongSignguCd: '150' };

    it('무장애 · 반려동물 지역 목록은 시군구 조건과 1000행으로 부른다', async () => {
      const t = new StubTransport([ok({ items: '' })]);
      await client(t).withAreaBasedList(region);
      await client(t).petAreaBasedList({ ...region, numOfRows: 5000 });
      expect(t.calls.map((c) => c.operation)).toEqual(['withAreaBasedList2', 'petAreaBasedList2']);
      for (const c of t.calls) expect(c.params).toEqual({ ...region, numOfRows: KTO_MAX_ROWS, pageNo: 1 });
    });

    it.each([
      [{ keyword: ' ' }, /이름이 비어/],
      [{ baseYm: '2026-08' }, /baseYm/],
      [{ areaCd: '5' }, /areaCd/],
      [{ signguCd: '150' }, /signguCd/],
      [{ signguCd: '11110' }, /signguCd/],
    ])('🔴 연관 관광지 조건 모양이 틀리면 부르기 전에 막는다 — 0건으로 순위가 사라진다 %o', async (override, message) => {
      const t = new StubTransport([ok({ items: '' })]);
      const params = { keyword: '경포대', baseYm: '202608', areaCd: '51', signguCd: '51150', ...override };
      const e = await client(t).relatedSearchKeyword(params).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(KtoInvalidRequestError);
      expect((e as Error).message).toMatch(message);
      expect(t.calls).toHaveLength(0);
    });

    it('방문자수는 한 달치 전국을 30000행 1콜로 부른다', async () => {
      const t = new StubTransport([ok({ items: '', totalCount: 0 })]);
      await client(t).locgoRegnVisitrDDList({ startYmd: '20250901', endYmd: '20250930' });
      expect(t.calls[0]?.params).toEqual({ startYmd: '20250901', endYmd: '20250930', numOfRows: KTO_VISITOR_ROWS, pageNo: 1 });
    });

    it.each([
      ['20250801', '20250901'], // 32일 — 1콜에 다 오지 않는다
      ['20250930', '20250901'], // 끝이 앞선다
      ['20250231', '20250301'], // 없는 날짜
      ['2025-09-01', '2025-09-30'],
    ])('🔴 방문자수 기간 %s – %s 는 부르기 전에 막는다', async (startYmd, endYmd) => {
      const t = new StubTransport([ok({ items: '' })]);
      await expect(client(t).locgoRegnVisitrDDList({ startYmd, endYmd })).rejects.toBeInstanceOf(KtoInvalidRequestError);
      expect(t.calls).toHaveLength(0);
    });

    it('31일은 받는다', async () => {
      const t = new StubTransport([ok({ items: '', totalCount: 0 })]);
      await expect(client(t).locgoRegnVisitrDDList({ startYmd: '20251001', endYmd: '20251031' })).resolves.toBeDefined();
    });

    it('🔴 한 번에 온다고 본 전국 목록이 잘려 오면 던진다 — 있는 걷기 길이 없다고 나온다', async () => {
      const t = new StubTransport([ok({ items: { item: [{ crsIdx: 'T_CRS_MNG0000000001' }] }, totalCount: 142 })]);
      await expect(client(t).courseList()).rejects.toThrow(/한 번에 다 오지 않았다: 1 \/ 142건/);
    });

    it('위치기반 · 지역기반 목록의 분류 조건은 값이 있을 때만 보낸다', async () => {
      const t = new StubTransport([ok({ items: '' })]);
      await client(t).locationBasedList({ mapX: 1, mapY: 1, radius: 3000, lclsSystm1: 'FD' });
      await client(t).areaBasedList({ ...region, lclsSystm2: 'VE01', numOfRows: 1 });
      expect(t.calls[0]?.params).toMatchObject({ lclsSystm1: 'FD' });
      expect(t.calls[0]?.params).not.toHaveProperty('lclsSystm2');
      expect(t.calls[1]?.params).toMatchObject({ lclsSystm2: 'VE01', numOfRows: 1 });
      expect(t.calls[1]?.params).not.toHaveProperty('lclsSystm1');
    });

    it('🔴 파라미터 오류는 다시 보내지 않는다 — 두루누비는 봉투 없이 최상위에 준다', async () => {
      const t = new StubTransport([JSON.stringify({ resultCode: '10', resultMsg: 'INVALID_REQUEST_PARAMETER_ERROR(crsIdx)' })]);
      const e = await client(t).courseList().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(KtoInvalidRequestError);
      expect(t.calls).toHaveLength(1);
      expect(logger.entries).toHaveLength(1);
      expect(logger.entries[0]).toMatchObject({ provider: 'KTO_DURUNUBI', status: 'FAIL', resultCode: '10' });
    });
  });

  describe('파라미터 계약', () => {
    it('numOfRows 는 1000 을 넘지 않는다 (EI-KT-013)', async () => {
      const t = new StubTransport([ok({ items: '' })]);
      await client(t).searchKeyword({ keyword: '강릉', numOfRows: 5000 });
      expect(t.calls[0]?.params.numOfRows).toBe(KTO_MAX_ROWS);
    });

    it('반경 20km 초과는 조용히 자르지 않고 던진다 (EI-KT-008)', async () => {
      // 잘라내면 화면에 표시된 반경과 실제 조회 반경이 어긋난다
      const t = new StubTransport([ok({ items: '' })]);
      await expect(
        client(t).locationBasedList({ mapX: 128.8, mapY: 37.79, radius: 20001 }),
      ).rejects.toThrow(/반경 상한 초과/);
      expect(t.calls).toHaveLength(0);
    });

    it('반경 20,000m 정확히는 허용한다', async () => {
      const t = new StubTransport([ok({ items: '' })]);
      await expect(client(t).locationBasedList({ mapX: 1, mapY: 1, radius: 20000 })).resolves.toBeDefined();
    });

    it('지원하지 않는 contentTypeId 는 호출 전에 막는다', async () => {
      const t = new StubTransport([ok({ items: '' })]);
      await expect(client(t).detailIntro('1', 25 as 12)).rejects.toThrow(/contentTypeId/);
      expect(t.calls).toHaveLength(0);
    });

    it('선택 파라미터는 값이 없으면 아예 보내지 않는다', async () => {
      const t = new StubTransport([ok({ items: '' })]);
      await client(t).searchKeyword({ keyword: '강릉' });
      expect(t.calls[0]?.params).not.toHaveProperty('contentTypeId');
      expect(t.calls[0]?.params).not.toHaveProperty('lDongRegnCd');
    });

    it('행사 조회에 여행 시작일만 넘긴다 — 보정 로직을 넣지 않는다 (EI-KT-010)', async () => {
      const t = new StubTransport([ok({ items: '' })]);
      await client(t).searchFestival({ eventStartDate: '20261022' });
      expect(t.calls[0]?.params.eventStartDate).toBe('20261022');
      expect(t.calls[0]?.params).not.toHaveProperty('eventEndDate');
    });
  });

  describe('재시도 — 지수 백오프 최대 2회 (EI-CM-005)', () => {
    it('일시 실패는 재시도해서 성공한다', async () => {
      const t = new StubTransport([new KtoFetchError('searchKeyword2', 'HTTP 503'), ok({ items: { item: { contentid: '1' } } })]);
      const page = await client(t).searchKeyword({ keyword: '강릉' });
      expect(page.items).toHaveLength(1);
      expect(t.calls).toHaveLength(2);
    });

    it('계속 실패하면 최초 1회 + 재시도 2회 = 3회에서 멈춘다', async () => {
      const t = new StubTransport([new KtoFetchError('searchKeyword2', 'HTTP 503')]);
      await expect(client(t).searchKeyword({ keyword: '강릉' })).rejects.toBeInstanceOf(KtoFetchError);
      expect(t.calls).toHaveLength(3);
    });

    it('대기 시간이 지수로 늘어난다', async () => {
      const waits: number[] = [];
      const t = new StubTransport([new KtoFetchError('searchKeyword2', 'x')]);
      const c = new KtoClient({ transport: t, logger, clock: fakeClock(), baseDelayMs: 100, sleep: async (ms) => { waits.push(ms); } });
      await expect(c.searchKeyword({ keyword: '강릉' })).rejects.toThrow();
      expect(waits).toEqual([100, 200]);
    });

    it.each([
      ['인증 오류', new KtoAuthError('searchKeyword2', '30', 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR')],
      ['쿼터 초과', new KtoQuotaExceededError('searchKeyword2', '22', 'LIMITED')],
    ])('%s 는 재시도하지 않는다 — 남은 예산만 태운다', async (_label, error) => {
      const t = new StubTransport([error]);
      await expect(client(t).searchKeyword({ keyword: '강릉' })).rejects.toBe(error);
      expect(t.calls).toHaveLength(1);
    });

    it('타임아웃은 재시도한다', async () => {
      const t = new StubTransport([new KtoTimeoutError('detailCommon2', 10)]);
      await expect(client(t).detailCommon('1')).rejects.toBeInstanceOf(KtoTimeoutError);
      expect(t.calls).toHaveLength(3);
    });
  });

  describe('0건 처리', () => {
    it('상세 조회 0건은 CONTENT_NOT_FOUND 로 확정한다', async () => {
      const t = new StubTransport([ok({ items: '' })]);
      const e = await client(t).detailIntro('99999999', 12).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ContentNotFoundError);
      expect((e as ContentNotFoundError).reasonCode).toBe('CONTENT_NOT_FOUND');
      expect((e as ContentNotFoundError).retryable).toBe(false);
    });

    it('상세 0건은 재시도하지 않는다 — 없는 건 다시 불러도 없다', async () => {
      const t = new StubTransport([ok({ items: '' })]);
      await expect(client(t).detailIntro('99999999', 12)).rejects.toBeInstanceOf(ContentNotFoundError);
      expect(t.calls).toHaveLength(1);
    });

    it('목록 조회 0건은 정상이다 — 빈 목록을 돌려준다', async () => {
      const t = new StubTransport([ok({ items: '', totalCount: 0 })]);
      await expect(client(t).searchFestival({ eventStartDate: '20261022' })).resolves.toMatchObject({ items: [], totalCount: 0 });
    });
  });

  describe('호출 로그 — 증빙이자 예산 카운트의 근거다 (EI-CM-006 · FR-OP-001)', () => {
    it('성공 1건당 1행을 남긴다', async () => {
      await client(new StubTransport([ok({ items: '' })])).searchKeyword({ keyword: '강릉' });
      expect(logger.entries).toHaveLength(1);
      expect(logger.entries[0]).toMatchObject({ provider: 'KTO', operation: 'searchKeyword2', status: 'OK', resultCode: '0000', httpStatus: 200 });
    });

    it('🔴 제공자를 서비스마다 따로 적는다 — 새 서비스 호출이 국문 예산에 섞이지 않는다 (API 8-2)', async () => {
      const c = client(new StubTransport([ok({ items: { item: { contentid: '1' } }, totalCount: 1 })]));
      const region = { lDongRegnCd: '51', lDongSignguCd: '150' };
      await c.searchKeyword({ keyword: '강릉' });
      await c.withAreaBasedList(region);
      await c.detailWithTour('1');
      await c.petAreaBasedList(region);
      await c.detailPetTour('1');
      await c.relatedSearchKeyword({ keyword: '경포대', baseYm: '202608', areaCd: '51', signguCd: '51150' });
      await c.courseList();
      await c.locgoRegnVisitrDDList({ startYmd: '20250901', endYmd: '20250930' });
      expect(logger.entries.map((e) => [e.provider, e.operation])).toEqual([
        ['KTO', 'searchKeyword2'],
        ['KTO_WITH', 'withAreaBasedList2'],
        ['KTO_WITH', 'detailWithTour2'],
        ['KTO_PET', 'petAreaBasedList2'],
        ['KTO_PET', 'detailPetTour2'],
        ['KTO_RELATED', 'searchKeyword1'],
        ['KTO_DURUNUBI', 'courseList'],
        ['KTO_VISITOR', 'locgoRegnVisitrDDList'],
      ]);
    });

    it('픽스처 리플레이는 남기지 않는다 — 안 한 호출이 증빙에 섞이면 안 된다 (FR-OP-007)', async () => {
      await client(new FixtureKtoTransport(FIXTURES)).detailIntro('125769', 12);
      expect(logger.entries).toEqual([]);
    });

    it('재시도 1회마다 1행이다 — 실제 나간 호출 수로 세야 예산이 맞는다', async () => {
      const t = new StubTransport([new KtoFetchError('searchKeyword2', 'HTTP 503'), ok({ items: '' })]);
      await client(t).searchKeyword({ keyword: '강릉' });
      expect(logger.entries.map((e) => e.status)).toEqual(['FAIL', 'OK']);
    });

    it('타임아웃은 TIMEOUT 으로 구분해 남긴다', async () => {
      const t = new StubTransport([new KtoTimeoutError('detailCommon2', 10)]);
      await client(t).detailCommon('1').catch(() => undefined);
      expect(new Set(logger.entries.map((e) => e.status))).toEqual(new Set(['TIMEOUT']));
    });

    it('resultCode 이상도 코드를 담아 남긴다', async () => {
      const body = JSON.stringify({ response: { header: { resultCode: '0001', resultMsg: 'APPLICATION ERROR' } } });
      await client(new StubTransport([body])).searchKeyword({ keyword: '강릉' }).catch(() => undefined);
      expect(logger.entries[0]).toMatchObject({ status: 'FAIL', resultCode: '0001' });
    });

    it('배치 호출은 auditRunId 가 null 이고, 검수 호출은 실행 id 를 단다', async () => {
      await client(new StubTransport([ok({ items: '' })])).searchKeyword({ keyword: '강릉' });
      await client(new StubTransport([ok({ items: '' })]), { auditRunId: 42 }).searchKeyword({ keyword: '강릉' });
      expect(logger.entries.map((e) => e.auditRunId)).toEqual([null, 42]);
    });

    it('소요시간을 기록한다', async () => {
      await client(new StubTransport([ok({ items: '' })])).searchKeyword({ keyword: '강릉' });
      expect(logger.entries[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('로그 항목에 인증키·응답 원문이 들어갈 자리가 없다', async () => {
      const t = new StubTransport([ok({ items: { item: { contentid: '1', restdate: '매주 월요일 휴관' } } })]);
      await client(t).searchKeyword({ keyword: '강릉' });
      const serialized = JSON.stringify(logger.entries);
      expect(serialized).not.toContain('restdate');
      expect(serialized).not.toContain('휴관');
    });

    describe('증빙 로깅 장애가 서비스 장애가 되면 안 된다', () => {
      const failing = { record: (): never => { throw new Error('DB down'); } };

      it('로깅이 동기로 던져도 호출은 성공한다', async () => {
        const c = new KtoClient({ transport: new StubTransport([ok({ items: '' })]), logger: failing, sleep: noSleep, clock: fakeClock() });
        await expect(c.searchKeyword({ keyword: '강릉' })).resolves.toMatchObject({ items: [] });
      });

      it('로깅이 비동기로 실패해도 호출은 성공한다', async () => {
        const c = new KtoClient({
          transport: new StubTransport([ok({ items: '' })]),
          logger: { record: async (): Promise<never> => { throw new Error('DB down'); } },
          sleep: noSleep,
          clock: fakeClock(),
        });
        await expect(c.searchKeyword({ keyword: '강릉' })).resolves.toBeDefined();
      });

      it('원래 실패를 로깅 오류로 덮어쓰지 않는다', async () => {
        // finally 안에서 던지면 쿼터 초과가 'DB down' 으로 둔갑한다
        const quota = new KtoQuotaExceededError('searchKeyword2', '22', 'LIMITED');
        const c = new KtoClient({ transport: new StubTransport([quota]), logger: failing, sleep: noSleep, clock: fakeClock() });
        await expect(c.searchKeyword({ keyword: '강릉' })).rejects.toBe(quota);
      });

      it('실패 사실은 onLogFailure 로 알린다 — 조용히 사라지진 않는다', async () => {
        const seen: unknown[] = [];
        const c = new KtoClient({
          transport: new StubTransport([ok({ items: '' })]),
          logger: failing, sleep: noSleep, clock: fakeClock(),
          onLogFailure: (e) => seen.push(e),
        });
        await c.searchKeyword({ keyword: '강릉' });
        expect(seen).toHaveLength(1);
      });
    });
  });

  it('같은 입력이면 같은 결과다 (NF-MT-001)', async () => {
    const fixture = new FixtureKtoTransport(FIXTURES);
    const a = await client(fixture).detailIntro('125769', 12);
    const b = await client(fixture).detailIntro('125769', 12);
    expect(a).toEqual(b);
  });
});
