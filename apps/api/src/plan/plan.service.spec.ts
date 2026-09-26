import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlanBriefing, PlanPlace } from '@tourlint/shared';
import { DomainException } from '../common/domain.exception';
import type { BudgetDecision } from '../external/budget-guard';
import { InMemoryApiCallLogger } from '../external/api-call-log';
import { FixtureKtoTransport, KtoClient, KtoFetchError, type KtoParams, type KtoTransport, type KtoTransportResult } from '../external/kto';
import { PlanCache } from './plan-cache';
import { readPlaceDetailQuery } from './plan.dto';
import { PlanService, facilitiesLast, relatedBaseYm, type BriefingQuery, type PlacesQuery } from './plan.service';

const FIXTURES = join(__dirname, '../../../../fixtures/kto');
const GANGNEUNG = { regnCd: '51', signguCd: '150' };

const allowed: BudgetDecision = { allowed: true, ratio: 0.1, reasonCode: null, warn: false, remaining: 720 };
const blocked: BudgetDecision = { allowed: false, ratio: 1, reasonCode: 'BUDGET_EXHAUSTED', warn: true, remaining: 0 };

const briefingQuery = (over: Partial<BriefingQuery> = {}): BriefingQuery => ({
  ...GANGNEUNG, startDate: '2026-10-23', nights: 1, extraLcls2: [], ...over,
});

const placesQuery = (over: Partial<PlacesQuery> = {}): PlacesQuery => ({
  ...GANGNEUNG, scope: 'SIGNGU', lcls2: 'VE01', nearKind: null, sort: null, anchor: null,
  anchorContentId: null, wheelchair: false, pet: false, indoor: false, page: 1, ...over,
});

function fixtureService(budget: Partial<Record<string, BudgetDecision>> = {}): PlanService {
  const fixtures = new FixtureKtoTransport(FIXTURES);
  // 이 지역 목록 스냅샷은 대표 행만 담았다. 페이징은 아래 전용 transport로 검증한다.
  const transport: KtoTransport = { kind: 'fixture', async request(operation, params) {
    const result = await fixtures.request(operation, params);
    if (operation !== 'areaBasedList2') return result;
    const parsed = JSON.parse(result.body);
    parsed.response.body.totalCount = parsed.response.body.items.item.length;
    return { ...result, body: JSON.stringify(parsed) };
  } };
  return new PlanService({
    kto: () => new KtoClient({ transport, logger: new InMemoryApiCallLogger() }),
    budget: async (service) => budget[service] ?? allowed,
    cache: new PlanCache(),
  });
}

describe('PlanService — 픽스처로 도는 기획 조회 (FR-PL-010 · 011)', () => {
  it('종류 칩 첫째 줄과 지역 요약을 돌려준다', async () => {
    const briefing: PlanBriefing = await fixtureService().briefing(briefingQuery());

    expect(briefing.region).toEqual({ regnCd: '51', signguCd: '150', name: '강릉시' });
    expect(briefing.types.map((t) => [t.kind, t.lcls2, t.name])).toEqual([
      ['LCLS2', 'VE01', '랜드마크관광'],
      ['LCLS2', 'NA02', '자연경관(하천‧해양)'],
      ['LCLS2', 'VE07', '전시시설'],
      ['LCLS2', 'EX02', '공예체험'],
      ['EVENT', null, '축제 · 공연'],
      ['WALK', null, '걷기 길'],
    ]);
    // 강릉 무장애 729 · 반려동물 110 · 걷기 길 4 (2026.09.15 실호출 스냅샷)
    expect(briefing.accessible).toEqual({ count: 729 });
    expect(briefing.pet).toEqual({ count: 110 });
    expect(briefing.walks).toEqual({ count: 4 });
    expect(briefing.events).toEqual({ count: 1, from: '2026-10-20', to: '2026-10-27' });
    expect(briefing.budget).toBe('OK');
  });

  it('🔴 근처 3km 식당은 가까운 순이고 주점 · 카페가 빠진다 (PLAN_NEAR_KIND)', async () => {
    const result = await fixtureService().places(placesQuery({
      scope: 'NEAR3KM', nearKind: 'MEAL', lcls2: null, anchor: { mapx: 128.8947, mapy: 37.7517 },
    }));

    // 3km 음식 185건 중 카페(FD05) 36건을 뺀 149건
    expect(result.totalCount).toBe(149);
    expect(result.scope.kind).toBe('NEAR3KM');
    expect(result.items.every((p) => p.lcls2 !== 'FD05' && p.lcls2 !== 'FD04')).toBe(true);
    expect(result.items.every((p) => p.togetherRank === null)).toBe(true);
    const distances = result.items.map((p) => p.distanceM ?? 0);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
  });

  it('카페 칩은 FD05 만, 숙소 칩은 숙박만이다', async () => {
    const service = fixtureService();
    const anchor = { mapx: 128.8947, mapy: 37.7517 };
    const cafe = await service.places(placesQuery({ scope: 'NEAR3KM', nearKind: 'CAFE', lcls2: null, anchor }));
    const stay = await service.places(placesQuery({ scope: 'NEAR3KM', nearKind: 'STAY', lcls2: null, anchor }));
    expect(cafe.totalCount).toBe(36);
    expect(cafe.items.every((p) => p.lcls2 === 'FD05')).toBe(true);
    expect(stay.totalCount).toBe(58);
    expect(stay.items.every((p) => p.lcls1 === 'AC')).toBe(true);
  });

  it('장소 카드에 판정 · 등급 · 규칙 번호가 없다 (FR-PL-021)', async () => {
    const result = await fixtureService().places(placesQuery());
    const place = result.items[0] as PlanPlace;
    expect(Object.keys(place).sort()).toEqual([
      'addr1', 'contentId', 'contentTypeId', 'distanceM', 'firstImage', 'indoorOutdoor',
      'lcls1', 'lcls2', 'lcls2Name', 'mapx', 'mapy', 'pet', 'title', 'togetherRank', 'wheelchair',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/"(grade|severity|verdict|score|ruleCode)"|R0[1-9]|R10/);
  });

  it('무장애 · 반려동물은 지역 목록 집합으로 표시한다', async () => {
    const result = await fixtureService().places(placesQuery({ lcls2: 'VE07' }));
    // 가람집옹심이(2868839)는 강릉 무장애 목록에 있고 반려동물 목록에는 없다
    const place = result.items.find((p) => p.contentId === '2868839');
    expect(place?.wheelchair).toBe(true);
    expect(place?.pet).toBe(false);
    expect(result.items.every((p) => p.wheelchair !== null && p.pet !== null)).toBe(true);
  });
});

describe('축제 · 공연과 걷기 길 (FR-PL-014 · 015)', () => {
  it('여행 기간 앞뒤 3일 창으로 부르고 겹치는 행사는 옮길 출발일을 제안하지 않는다', async () => {
    const events = await fixtureService().events(briefingQuery());
    expect(events.window).toEqual({ from: '2026-10-20', to: '2026-10-27' });
    // 픽스처의 강릉커피축제는 10-21 ~ 10-25 로 여행(10-23 ~ 10-24)과 겹친다
    expect(events.items).toHaveLength(1);
    expect(events.items[0]).toMatchObject({ relation: 'IN', suggestedStartDate: null, eventStart: '2026-10-21', eventEnd: '2026-10-25' });
  });

  it('🔴 걷기 길은 상품 지역 것만이고 좌표가 없다 (EI-KT-025)', async () => {
    const walks = await fixtureService().walks(GANGNEUNG);
    // 전국 141개 중 강릉 4개
    expect(walks.items).toHaveLength(4);
    expect(walks.items.every((w) => w.walkId.startsWith('T_CRS_MNG'))).toBe(true);
    expect(walks.items[0]).toMatchObject({ lengthKm: 16, minutes: 330, level: 1 });
    expect(JSON.stringify(walks.items)).not.toContain('mapx');
    expect(walks.notice).toContain('직접 정한 곳');
  });

  it('🔴 시군구 이름을 모르면 시도로 넓히지 않고 비운다 — 물어본 것보다 넓게 주지 않는다', async () => {
    // 픽스처에 서울 시군구 코드표가 없어 이름을 못 찾는다. 전국 목록에는 서울 코스가 있다
    const walks = await fixtureService().walks({ regnCd: '11', signguCd: '110' });
    expect(walks.items).toEqual([]);
  });

  it('세종처럼 시군구 단계가 없으면 시도 약칭으로 거른다', async () => {
    const walks = await fixtureService().walks({ regnCd: '36110', signguCd: null });
    expect(walks.items.every((w) => w.name !== '')).toBe(true);
  });
});

/** 어떤 파라미터로 불렀는지 보고 정해진 응답을 돌려주는 트랜스포트 */
class RecordingTransport implements KtoTransport {
  readonly kind = 'http' as const;
  readonly calls: { operation: string; params: KtoParams }[] = [];
  constructor(private readonly bodies: Partial<Record<string, unknown>> = {}) {}

  async request(operation: string, params: KtoParams): Promise<KtoTransportResult> {
    this.calls.push({ operation, params });
    const body = this.bodies[operation];
    if (body instanceof Error) throw body;
    return { body: envelope(body ?? { items: '', totalCount: 0 }), httpStatus: 200 };
  }

  paramsOf(operation: string): readonly KtoParams[] {
    return this.calls.filter((c) => c.operation === operation).map((c) => c.params);
  }
}

const envelope = (body: unknown): string =>
  JSON.stringify({ response: { header: { resultCode: '0000', resultMsg: 'OK' }, body } });

const listBody = (items: readonly Record<string, unknown>[], totalCount = items.length): unknown =>
  ({ items: { item: items }, totalCount, numOfRows: items.length, pageNo: 1 });

const place = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  contentid: '1', contenttypeid: '12', title: '곳', addr1: '강릉시', lclsSystm1: 'VE', lclsSystm2: 'VE01',
  mapx: '128.9', mapy: '37.75', ...over,
});

function service(transport: KtoTransport, budget: Partial<Record<string, BudgetDecision>> = {}): PlanService {
  return new PlanService({
    // 실패 경로도 기다리지 않는다 — 재시도 간격은 KtoClient spec 이 본다
    kto: () => new KtoClient({ transport, logger: new InMemoryApiCallLogger(), sleep: async () => undefined }),
    budget: async (s) => budget[s] ?? allowed,
    cache: new PlanCache(),
  });
}

describe('PlanService — 조회 조건과 경계', () => {
  it('🔴 칩 숫자와 목록은 같은 조건으로 부른다 — 수가 어긋나면 화면이 거짓말을 한다', async () => {
    const transport = new RecordingTransport({ areaBasedList2: listBody(Array.from({ length: 7 }, (_, i) => place({ contentid: String(i) }))) });
    const svc = service(transport);
    await svc.briefing(briefingQuery());
    await svc.places(placesQuery({ lcls2: 'VE01' }));

    const calls = transport.paramsOf('areaBasedList2');
    const chip = calls[0];
    const list = calls.at(-1);
    expect(chip).toMatchObject({ lDongRegnCd: '51', lDongSignguCd: '150', lclsSystm2: 'VE01', numOfRows: 1 });
    expect(list).toMatchObject({ lDongRegnCd: '51', lDongSignguCd: '150', lclsSystm2: 'VE01' });
    expect(list?.numOfRows).toBe(100);
  });

  it('🔴 첫째 줄에 식당 · 카페 · 숙소 칩이 없다 — 그것은 근처 3km 로만 연다 (D6)', async () => {
    const transport = new RecordingTransport({ areaBasedList2: listBody([], 0) });
    const briefing = await service(transport).briefing(briefingQuery({ extraLcls2: ['FD01', 'FD05', 'AC01', 'HS01'] }));
    const codes = briefing.types.filter((t) => t.kind === 'LCLS2').map((t) => t.lcls2);
    expect(codes).toEqual(['VE01', 'NA02', 'VE07', 'EX02', 'HS01']);
  });

  it('🔴 근처 3km 는 앵커가 없으면 부르지 않는다 (EX-PL-008)', async () => {
    const transport = new RecordingTransport();
    const result = await service(transport).places(placesQuery({ scope: 'NEAR3KM', nearKind: 'MEAL', lcls2: null }));
    expect(result.disabled).toBe('ANCHOR_REQUIRED');
    expect(result.items).toEqual([]);
    expect(transport.calls).toEqual([]);
  });

  it('🔴 국문 관광정보 예산이 다 찼으면 부르기 전에 429 다 (D2 · EI-CM-012)', async () => {
    const transport = new RecordingTransport();
    const e = await service(transport, { KOR: blocked }).briefing(briefingQuery()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DomainException);
    expect((e as DomainException).getStatus()).toBe(429);
    expect((e as DomainException).reasonCode).toBe('BUDGET_EXHAUSTED');
    expect(String((e as DomainException).getResponse())).not.toContain('호출');
    expect(transport.calls).toEqual([]);
  });

  it('🔴 새 서비스 하나가 막히거나 실패해도 그 필드만 null 이다 (EX-PL-004)', async () => {
    const transport = new RecordingTransport({
      areaBasedList2: listBody([place()], 1),
      detailWithTour2: new KtoFetchError('withAreaBasedList2', 'HTTP 503'),
    });
    const svc = service(transport, { PET: blocked });
    const briefing = await svc.briefing(briefingQuery());
    expect(briefing.pet).toBeNull();
    expect(briefing.accessible).toEqual({ count: 0 });
    expect(briefing.types[0]?.count).toBe(1);
    expect(transport.paramsOf('petAreaBasedList2')).toEqual([]);
  });

  it('🔴 무장애 목록을 못 받으면 「아니다」가 아니라 모른다 — 필터는 확인된 곳만 남긴다', async () => {
    const transport = new RecordingTransport({
      areaBasedList2: listBody([place({ contentid: '1' }), place({ contentid: '2' })]),
      withAreaBasedList2: new KtoFetchError('withAreaBasedList2', 'HTTP 503'),
      petAreaBasedList2: listBody([place({ contentid: '2' })]),
    });
    const svc = service(transport);
    const all = await svc.places(placesQuery());
    expect(all.items.map((p) => p.wheelchair)).toEqual([null, null]);
    expect(all.items.map((p) => p.pet)).toEqual([false, true]);
    expect(all.notice).toContain('일부 표시가 비어');

    const onlyWheelchair = await svc.places(placesQuery({ wheelchair: true }));
    expect(onlyWheelchair.items).toEqual([]);
    const onlyPet = await svc.places(placesQuery({ pet: true }));
    expect(onlyPet.items.map((p) => p.contentId)).toEqual(['2']);
  });

  it('🔴 화장실은 목록 맨 뒤다 — 건수는 그대로다 (#730)', async () => {
    const transport = new RecordingTransport({
      areaBasedList2: listBody([
        place({ contentid: '1', title: '강문해변화장실' }), place({ contentid: '2', title: '경포대' }), place({ contentid: '3', title: '오죽헌' }),
      ]),
    });
    const result = await service(transport).places(placesQuery());
    expect(result.items.map((p) => p.contentId)).toEqual(['2', '3', '1']);
    expect(result.totalCount).toBe(3);
  });

  it('🔴 비표출로 바뀐 곳은 목록에서 뺀다', async () => {
    const transport = new RecordingTransport({
      areaBasedList2: listBody([place({ contentid: '1', showflag: '1' }), place({ contentid: '2', showflag: '0' })]),
    });
    const result = await service(transport).places(placesQuery());
    expect(result.items.map((p) => p.contentId)).toEqual(['1']);
  });

  it('같은 조회를 다시 열어도 공사를 다시 부르지 않는다 — 10분 캐시', async () => {
    const transport = new RecordingTransport({ areaBasedList2: listBody([place()]) });
    const svc = service(transport);
    await svc.places(placesQuery());
    await svc.places(placesQuery({ page: 2 }));
    expect(transport.paramsOf('areaBasedList2')).toHaveLength(1);
  });

  it('실내만 필터는 중분류 실내 · 야외 시드로 거른다', async () => {
    const transport = new RecordingTransport({
      // VE07 전시시설 = 실내, NA02 자연관광지 = 야외
      areaBasedList2: listBody([place({ contentid: '1', lclsSystm2: 'VE07' }), place({ contentid: '2', lclsSystm2: 'NA02' })]),
    });
    const result = await service(transport).places(placesQuery({ indoor: true }));
    expect(result.items.map((p) => p.contentId)).toEqual(['1']);
  });

  describe('함께 많이 가는 순 (EI-KT-024)', () => {
    const related = (rows: readonly Record<string, unknown>[]): unknown => listBody(rows);
    const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      tAtsNm: '경포대', rlteTatsNm: '오죽헌', rlteCtgryLclsNm: '관광지', rlteSignguCd: '51150', rlteRank: '1', ...over,
    });

    it('🔴 이름이 한 곳과만 맞을 때 순위를 붙인다 — 여럿이면 붙이지 않는다', async () => {
      const transport = new RecordingTransport({
        areaBasedList2: listBody([
          place({ contentid: '1', title: '오죽헌' }),
          place({ contentid: '2', title: '경포해변' }),
          place({ contentid: '3', title: '경포해변' }),
        ]),
        detailCommon2: listBody([{ contentid: '9', title: '경포대' }]),
        searchKeyword1: related([row(), row({ rlteTatsNm: '경포해변', rlteRank: '2' })]),
      });
      const result = await service(transport).places(placesQuery({
        sort: 'together', anchorContentId: '9', anchor: { mapx: 128.9, mapy: 37.79 },
      }));
      expect(result.items.map((p) => [p.contentId, p.togetherRank])).toEqual([['1', 1], ['2', null], ['3', null]]);
    });

    it('🔴 기준 관광지가 앵커와 다른 줄과 음식 · 숙박 순위는 쓰지 않는다', async () => {
      const transport = new RecordingTransport({
        areaBasedList2: listBody([place({ contentid: '1', title: '오죽헌' }), place({ contentid: '2', title: '초당순두부' })]),
        detailCommon2: listBody([{ contentid: '9', title: '경포대' }]),
        searchKeyword1: related([
          row({ tAtsNm: '다른 기준지', rlteTatsNm: '오죽헌' }),
          row({ rlteTatsNm: '초당순두부', rlteCtgryLclsNm: '음식', rlteRank: '1' }),
        ]),
      });
      const result = await service(transport).places(placesQuery({
        sort: 'together', anchorContentId: '9', anchor: { mapx: 128.9, mapy: 37.79 },
      }));
      expect(result.items.every((p) => p.togetherRank === null)).toBe(true);
    });

    it('앵커 이름은 목록에 있으면 그것을 쓰고 없으면 공통정보 1콜로 확인한다', async () => {
      const transport = new RecordingTransport({
        areaBasedList2: listBody([place({ contentid: '1', title: '오죽헌' })]),
        detailCommon2: listBody([{ contentid: '9', title: '경포대' }]),
        searchKeyword1: related([row()]),
      });
      const result = await service(transport).places(placesQuery({
        sort: 'together', anchorContentId: '9', anchor: { mapx: 128.9, mapy: 37.79 },
      }));
      expect(transport.paramsOf('detailCommon2')).toHaveLength(1);
      expect(transport.paramsOf('searchKeyword1')[0]).toMatchObject({ keyword: '경포대', areaCd: '51', signguCd: '51150' });
      expect(result.items[0]?.togetherRank).toBe(1);
    });

    it('앵커가 없으면 순위를 붙이지 않고 안내만 한다', async () => {
      const transport = new RecordingTransport({ areaBasedList2: listBody([place()]) });
      const result = await service(transport).places(placesQuery({ sort: 'together' }));
      expect(transport.paramsOf('searchKeyword1')).toEqual([]);
      expect(result.notice).toContain('기준이 될 장소');
      // 매기지 않은 순위의 기준 달은 적지 않는다
      expect(result.scope.label).not.toContain('기준 함께 많이 가는 순');
    });

    it('🔴 순위를 매기면 어느 달 자료인지 머리글에 적는다 — 기능설명서의 집계 기간 표시 (#832)', async () => {
      const transport = new RecordingTransport({
        areaBasedList2: listBody([place({ contentid: '1', title: '오죽헌' })]),
        detailCommon2: listBody([{ contentid: '9', title: '경포대' }]),
        searchKeyword1: related([row()]),
      });
      const result = await service(transport).places(placesQuery({
        sort: 'together', anchorContentId: '9', anchor: { mapx: 128.9, mapy: 37.79 },
      }));
      const ym = relatedBaseYm();
      // 부른 달과 적은 달이 같다
      expect(transport.paramsOf('searchKeyword1')[0]).toMatchObject({ baseYm: ym });
      expect(result.scope.label).toContain(`${ym.slice(0, 4)}년 ${String(Number(ym.slice(4, 6)))}월 기준 함께 많이 가는 순`);
    });
  });

  describe('축제 기간 관계 (FR-PL-014)', () => {
    const festival = (over: Record<string, unknown>): Record<string, unknown> => ({
      contentid: '825295', contenttypeid: '15', title: '축제', ...over,
    });

    it('🔴 여행 뒤에 열리면 옮길 출발일을 제안한다', async () => {
      const transport = new RecordingTransport({
        searchFestival2: listBody([festival({ eventstartdate: '20261101', eventenddate: '20261103' })]),
      });
      const events = await service(transport).events(briefingQuery());
      expect(events.items[0]).toMatchObject({ relation: 'AFTER', suggestedStartDate: '2026-11-01' });
    });

    it('🔴 기간을 모르는 행사는 목록에 넣지 않는다 — 겹치는지 말할 수 없다', async () => {
      const transport = new RecordingTransport({
        // 끝나는 날만 있고 시작일이 비어 있으면 겹치는지 말할 수 없다
        searchFestival2: listBody([festival({ eventstartdate: '', eventenddate: '20261026' }), festival({ eventstartdate: '20261024', eventenddate: '20261026' })]),
      });
      const events = await service(transport).events(briefingQuery());
      expect(events.items).toHaveLength(1);
      expect(events.items[0]?.relation).toBe('IN');
    });

    it('창이 시작하기 전에 끝난 행사는 빼고, 창의 시작일로 부른다 (EI-KT-010)', async () => {
      const transport = new RecordingTransport({
        searchFestival2: listBody([festival({ eventstartdate: '20261001', eventenddate: '20261005' })]),
      });
      const events = await service(transport).events(briefingQuery());
      expect(events.items).toEqual([]);
      expect(transport.paramsOf('searchFestival2')[0]).toMatchObject({ eventStartDate: '20261020' });
    });
  });

  it('가까운 순은 반경 20km 조회의 거리로 정렬하고, 그 안에 없으면 뒤에 둔다', async () => {
    const transport = new RecordingTransport({
      areaBasedList2: listBody([place({ contentid: '1' }), place({ contentid: '2' }), place({ contentid: '3' })]),
      locationBasedList2: listBody([
        { ...place({ contentid: '2' }), dist: '900.4' },
        { ...place({ contentid: '1' }), dist: '12000' },
      ]),
    });
    const result = await service(transport).places(placesQuery({ sort: 'near', anchor: { mapx: 128.9, mapy: 37.79 } }));
    expect(result.items.map((p) => [p.contentId, p.distanceM])).toEqual([['2', 900], ['1', 12000], ['3', null]]);
    expect(transport.paramsOf('locationBasedList2')[0]).toMatchObject({ radius: 20_000 });
  });
});

describe('카드 자세히 (placeDetail · FR-PL-012)', () => {
  it('detailIntro2 로 이용시간 · 쉬는 날 · 주차를 채운다', async () => {
    const transport = new RecordingTransport({
      detailIntro2: listBody([{ usetime: '09:00~18:00', restdate: '월요일 휴무', parking: '가능' }]),
    });
    const d = await service(transport).placeDetail({ contentId: '1', contentTypeId: 12 });
    expect(d).toMatchObject({ contentId: '1', hours: '09:00~18:00', restDays: '월요일 휴무', parking: '가능' });
    expect(transport.paramsOf('detailIntro2')).toHaveLength(1);
  });

  it('🔴 캐시가 없어 펼칠 때마다 실호출한다', async () => {
    const transport = new RecordingTransport({ detailIntro2: listBody([{ usetime: '09:00~18:00' }]) });
    const svc = service(transport);
    await svc.placeDetail({ contentId: '1', contentTypeId: 12 });
    await svc.placeDetail({ contentId: '1', contentTypeId: 12 });
    expect(transport.paramsOf('detailIntro2')).toHaveLength(2);
  });

  it('🔴 국문 관광정보 예산이 다 찼으면 부르기 전에 429 다', async () => {
    const transport = new RecordingTransport();
    const e = await service(transport, { KOR: blocked }).placeDetail({ contentId: '1', contentTypeId: 12 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DomainException);
    expect((e as DomainException).getStatus()).toBe(429);
    expect(transport.calls).toEqual([]);
  });

  it('소개정보를 못 받으면 값은 다 null 이고 카드는 열린다 (EX-PL-004)', async () => {
    const transport = new RecordingTransport({ detailIntro2: new KtoFetchError('detailIntro2', 'HTTP 503') });
    const d = await service(transport).placeDetail({ contentId: '1', contentTypeId: 12 });
    expect(d).toEqual({ contentId: '1', hours: null, restDays: null, fee: null, parking: null, eventPeriod: null, contact: null });
  });

  it('🔴 문의처를 유형에 맞는 소개정보 필드에서 채운다 (UI-S2-040 · #850)', async () => {
    const transport = new RecordingTransport({
      detailIntro2: listBody([{ usetimeculture: '09:00~18:00', infocenterculture: '033-660-3301' }]),
    });
    const d = await service(transport).placeDetail({ contentId: '1', contentTypeId: 14 });
    expect(d.contact).toBe('033-660-3301');
  });

  it('🔴 표시된 축은 상세를 1콜씩 불러 싣는다 — 전에는 상세를 한 번도 안 불렀다 (#850)', async () => {
    const transport = new RecordingTransport({
      detailIntro2: listBody([{ usetime: '09:00~18:00' }]),
      detailWithTour2: listBody([{ contentid: '1', wheelchair: '대여 가능', elevator: '있음' }]),
      detailPetTour2: listBody([{ contentid: '1', acmpyTypeCd: '전구역 동반가능' }]),
    });
    const d = await service(transport).placeDetail({ contentId: '1', contentTypeId: 12, want: { accessible: true, pet: true } });
    expect(d.accessible).toMatchObject({ wheelchair: '대여 가능', elevator: '있음' });
    expect(d.pet).toMatchObject({ acmpyTypeCd: '전구역 동반가능' });
    expect(transport.paramsOf('detailWithTour2')).toHaveLength(1);
    expect(transport.paramsOf('detailPetTour2')).toHaveLength(1);
  });

  it('요청하지 않은 축은 부르지도 싣지도 않는다', async () => {
    const transport = new RecordingTransport({
      detailIntro2: listBody([{ usetime: '09:00~18:00' }]),
      detailWithTour2: listBody([{ contentid: '1', wheelchair: '대여 가능' }]),
    });
    const d = await service(transport).placeDetail({ contentId: '1', contentTypeId: 12, want: { accessible: true, pet: false } });
    expect(d).not.toHaveProperty('pet');
    expect(transport.paramsOf('detailPetTour2')).toEqual([]);

    const plain = await service(transport).placeDetail({ contentId: '1', contentTypeId: 12 });
    expect(plain).not.toHaveProperty('accessible');
    expect(transport.paramsOf('detailWithTour2')).toHaveLength(1);
  });

  it('🔴 그 축을 못 받으면 null — 이용시간 등 나머지는 그대로다 (EX-PL-004)', async () => {
    const transport = new RecordingTransport({
      detailIntro2: listBody([{ usetime: '09:00~18:00' }]),
      detailWithTour2: new KtoFetchError('detailWithTour2', 'HTTP 503'),
    });
    const d = await service(transport).placeDetail({ contentId: '1', contentTypeId: 12, want: { accessible: true, pet: false } });
    expect(d.accessible).toBeNull();
    expect(d.hours).toBe('09:00~18:00');
  });

  it('무장애 예산이 다 찼으면 그 축만 null 이고 부르지 않는다', async () => {
    const transport = new RecordingTransport({
      detailIntro2: listBody([{ usetime: '09:00~18:00' }]),
      detailWithTour2: listBody([{ contentid: '1', wheelchair: '대여 가능' }]),
    });
    const d = await service(transport, { WITH: blocked }).placeDetail({
      contentId: '1', contentTypeId: 12, want: { accessible: true, pet: false },
    });
    expect(d.accessible).toBeNull();
    expect(transport.paramsOf('detailWithTour2')).toEqual([]);
  });
});

describe('카드 자세히 질의 읽기 (#850)', () => {
  it('with 로 축을 받는다', () => {
    expect(readPlaceDetailQuery({ contentId: '1', contentTypeId: '12', with: 'accessible,pet' }))
      .toEqual({ contentId: '1', contentTypeId: 12, want: { accessible: true, pet: true } });
    expect(readPlaceDetailQuery({ contentId: '1', contentTypeId: '12' })).toEqual({ contentId: '1', contentTypeId: 12 });
  });

  it('🔴 모르는 축은 튕긴다', () => {
    expect(() => readPlaceDetailQuery({ contentId: '1', contentTypeId: '12', with: 'accessible,parking' })).toThrow();
  });
});


describe('장소 담기 전체 페이지 (#564)', () => {
  class PagedTransport extends RecordingTransport {
    failSecond = false;
    constructor(readonly count: number, readonly operation: string = 'areaBasedList2') { super(); }
    override async request(operation: Parameters<KtoTransport['request']>[0], params: KtoParams): Promise<KtoTransportResult> {
      if (operation !== this.operation) return super.request(operation, params);
      this.calls.push({ operation, params });
      const page = Number(params.pageNo ?? 1);
      if (page === 2 && this.failSecond) throw new KtoFetchError(operation, 'test failure');
      const size = Number(params.numOfRows);
      const rows = Array.from({ length: this.count }, (_, i) => place({
        contentid: String(i + 1), lclsSystm1: 'FD', lclsSystm2: 'FD01', dist: this.count - i,
      })).slice((page - 1) * size, page * size);
      return { body: envelope(listBody(rows, this.count)), httpStatus: 200 };
    }
  }

  it('34곳을 20+14곳으로 빠짐·중복 없이 탐색한다', async () => {
    const transport = new PagedTransport(34);
    const svc = service(transport);
    const first = await svc.places(placesQuery());
    const last = await svc.places(placesQuery({ page: 2 }));
    expect(first.totalCount).toBe(34);
    expect(first.items).toHaveLength(20);
    expect(last.items).toHaveLength(14);
    expect(new Set([...first.items, ...last.items].map(p => p.contentId)).size).toBe(34);
    expect(transport.paramsOf('areaBasedList2')).toHaveLength(1);
  });

  it('원본 100곳 너머도 7페이지까지 보이고 다시 읽을 때 캐시를 쓴다', async () => {
    const transport = new PagedTransport(125);
    const svc = service(transport);
    const all = [];
    for (let page = 1; page <= 7; page++) {
      const result = await svc.places(placesQuery({ page }));
      expect(result.totalCount).toBe(125);
      all.push(...result.items.map(p => p.contentId));
    }
    expect(all).toHaveLength(125);
    expect(new Set(all).size).toBe(125);
    expect(transport.paramsOf('areaBasedList2').map(p => p.pageNo)).toEqual([1, 2]);
  });

  it('근처 원본 1000곳 너머도 전체 거리순으로 정렬한 뒤 페이지를 나눈다', async () => {
    const transport = new PagedTransport(1003, 'locationBasedList2');
    const svc = service(transport);
    const result = await svc.places(placesQuery({ scope: 'NEAR3KM', nearKind: 'MEAL', anchor: { mapx: 128.9, mapy: 37.75 } }));
    expect(result.totalCount).toBe(1003);
    expect(result.items[0]?.contentId).toBe('1003');
    const last = await svc.places(placesQuery({ scope: 'NEAR3KM', nearKind: 'MEAL', anchor: { mapx: 128.9, mapy: 37.75 }, page: 51 }));
    expect(last.items.map(p => p.contentId)).toEqual(['3', '2', '1']);
  });

  it('중간 실패를 일부 성공으로 캐시하지 않아 재시도로 전체를 받는다', async () => {
    const transport = new PagedTransport(125);
    transport.failSecond = true;
    const svc = service(transport);
    await expect(svc.places(placesQuery())).rejects.toBeInstanceOf(KtoFetchError);
    transport.failSecond = false;
    expect((await svc.places(placesQuery({ page: 7 }))).items).toHaveLength(5);
  });

  it('원본이 같은 페이지를 반복하면 잘린 전체 수를 반환하지 않는다', async () => {
    const transport = new RecordingTransport({ areaBasedList2: listBody([place()], 34) });
    await expect(service(transport).places(placesQuery())).rejects.toThrow('다음 페이지');
  });

  it('앵커가 없으면 반경 20km가 아닌 시군구 전체로 설명한다', async () => {
    const result = await service(new PagedTransport(34)).places(placesQuery({ sort: 'near' }));
    expect(result.scope.kind).toBe('SIGNGU');
    expect(result.scope.label).not.toContain('반경');
  });
});

describe('장소 목록의 편의시설 (#730)', () => {
  it('🔴 화장실은 맨 뒤로 보낸다 — 빼지 않고, 나머지 순서는 그대로다', () => {
    const titles = ['강문해변화장실', '경포대', '강릉 선교장', '안목해변 공중화장실', '오죽헌'];
    const ordered = facilitiesLast(titles.map((title) => ({ title })));
    expect(ordered.map((p) => p.title)).toEqual(['경포대', '강릉 선교장', '오죽헌', '강문해변화장실', '안목해변 공중화장실']);
  });

  it('편의시설이 없으면 그대로다', () => {
    const places = [{ title: '경포대' }, { title: '오죽헌' }];
    expect(facilitiesLast(places)).toEqual(places);
  });
});
