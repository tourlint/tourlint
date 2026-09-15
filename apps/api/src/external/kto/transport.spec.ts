import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseKtoResponse } from './envelope';
import { FixtureMissingError, KtoFetchError, KtoTimeoutError } from './kto.errors';
import { FixtureKtoTransport, HttpKtoTransport, type KtoParams } from './transport';

const FIXTURES = join(__dirname, '../../../../../fixtures/kto');

describe('FixtureKtoTransport — 픽스처 리플레이 (KTO_MODE=fixture)', () => {
  const transport = new FixtureKtoTransport(FIXTURES);

  /**
   * 픽스처만으로 **「등록 → 관광지 확정」을 끝까지 갈 수 있는가** (이슈 #350).
   *
   * 검색 후보와 상세 스냅샷이 안 겹치면 어느 후보를 골라도 확정에서 `FixtureMissingError` 가
   * 난다. 시드 상품은 `contentid` 를 직접 넣어 이 경로를 건너뛰므로 여기서 안 보면 안 드러난다.
   */
  it('검색 후보 중 적어도 하나는 상세 스냅샷을 가진다', async () => {
    const { body } = await transport.request('searchKeyword2', { keyword: '경포대' });
    const candidates = parseKtoResponse('searchKeyword2', body).items
      .map((i) => String((i as { contentid?: unknown }).contentid ?? ''));
    expect(candidates.length).toBeGreaterThan(0);

    const withDetail = candidates.filter((id) => transport.availableContentIds('detailCommon2').includes(id));
    expect(withDetail.length).toBeGreaterThan(0);

    // 그 후보로 확정까지 간다 — 좌표·분류는 detailCommon2 에서 온다
    const picked = withDetail[0] as string;
    const detail = await transport.request('detailCommon2', { contentId: picked });
    expect(parseKtoResponse('detailCommon2', detail.body).items.length).toBe(1);
  });

  it('검색어가 다르면 다른 스냅샷을 돌려준다', async () => {
    // 오퍼레이션만으로 색인하면 어떤 검색어를 넣어도 같은 후보가 나왔다 (이슈 #350)
    const gyeongpo = await transport.request('searchKeyword2', { keyword: '경포대' });
    const other = await transport.request('searchKeyword2', { keyword: '중앙시장' });
    expect(gyeongpo.body).not.toBe(other.body);
  });

  it('목록 조회는 오퍼레이션당 스냅샷 1개를 돌려준다', async () => {
    const { body, httpStatus } = await transport.request('searchKeyword2', { keyword: '강릉' });
    expect(httpStatus).toBeNull(); // HTTP 를 타지 않았다
    expect(parseKtoResponse('searchKeyword2', body).items.length).toBeGreaterThan(0);
  });

  it('ldongCode2 는 파라미터가 없으면 시도 스냅샷을 돌려준다', async () => {
    const { body } = await transport.request('ldongCode2', { numOfRows: 1000, pageNo: 1 });
    const items = parseKtoResponse('ldongCode2', body).items;
    expect(items).toContainEqual(expect.objectContaining({ code: '11', name: '서울특별시' }));
  });

  it('ldongCode2 시군구 조회는 시도 스냅샷으로 대체되지 않는다 — 스냅샷이 없으면 던진다', async () => {
    // 시군구 fixture 는 `_<지역코드>.json` 규칙으로 캡처해야 인식된다. 11 은 없으므로 미스.
    await expect(transport.request('ldongCode2', { lDongRegnCd: '11' })).rejects.toBeInstanceOf(
      FixtureMissingError,
    );
  });

  it('상세 조회는 contentId 로 정확히 그 콘텐츠를 돌려준다', async () => {
    const { body } = await transport.request('detailIntro2', { contentId: '125769' });
    const item = parseKtoResponse('detailIntro2', body).items[0];
    expect(item?.contentid).toBe('125769');
  });

  it('파일명이 아니라 본문의 contentid 로 색인한다', async () => {
    // type15_695592.json — 파일명 접두사가 다른 규칙이지만 같은 방식으로 찾는다
    const { body } = await transport.request('detailIntro2', { contentId: '695592' });
    expect(parseKtoResponse('detailIntro2', body).items[0]?.contentid).toBe('695592');
  });

  it('contentid 소문자 파라미터도 받는다', async () => {
    const { body } = await transport.request('detailIntro2', { contentid: '125769' });
    expect(parseKtoResponse('detailIntro2', body).items[0]?.contentid).toBe('125769');
  });

  it('7개 유형 전부 리플레이된다', async () => {
    const ids = transport.availableContentIds('detailIntro2');
    const types = new Set<unknown>();
    for (const id of ids) {
      const { body } = await transport.request('detailIntro2', { contentId: id });
      types.add(String(parseKtoResponse('detailIntro2', body).items[0]?.contenttypeid));
    }
    expect([...types].sort()).toEqual(['12', '14', '15', '28', '32', '38', '39']);
  });

  it('없는 콘텐츠는 다른 응답으로 대체하지 않고 던진다', async () => {
    // 슬쩍 다른 관광지를 돌려주면 검수 결과가 그럴듯하게 틀린다
    await expect(transport.request('detailIntro2', { contentId: '99999999' })).rejects.toBeInstanceOf(KtoFetchError);
  });

  it('픽스처 미스는 재시도 대상이 아니다 — 없는 스냅샷은 다시 불러도 없다', async () => {
    const e = await transport.request('detailIntro2', { contentId: '99999999' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FixtureMissingError);
    expect((e as FixtureMissingError).retryable).toBe(false);
  });

  it('없는 콘텐츠 오류는 보유 목록을 알려준다', async () => {
    const e = await transport.request('detailIntro2', { contentId: '99999999' }).catch((x: unknown) => x);
    expect((e as Error).message).toContain('보유 목록');
    expect((e as Error).message).toContain('125769');
  });

  it('스냅샷이 없는 오퍼레이션은 어떤 것도 대신 돌려주지 않는다', async () => {
    const empty = new FixtureKtoTransport(mkdtempSync(join(tmpdir(), 'kto-fixture-')));
    await expect(empty.request('searchKeyword2', { keyword: '강릉' })).rejects.toThrow(/픽스처가 없다/);
  });

  it('같은 요청은 언제나 같은 본문을 돌려준다', async () => {
    const a = await transport.request('detailIntro2', { contentId: '129784' });
    const b = await transport.request('detailIntro2', { contentId: '129784' });
    expect(a.body).toBe(b.body);
  });
});

describe('FixtureKtoTransport — 새 서비스 5종 (EI-KT-022 ~ 026)', () => {
  const transport = new FixtureKtoTransport(FIXTURES);
  const itemsOf = async (operation: Parameters<typeof transport.request>[0], params: KtoParams) =>
    parseKtoResponse(operation, (await transport.request(operation, params)).body).items;
  const GANGNEUNG = { lDongRegnCd: '51', lDongSignguCd: '150' };

  it('무장애 · 반려동물 지역 목록은 시도 · 시군구로 찾는다', async () => {
    const withItems = await itemsOf('withAreaBasedList2', GANGNEUNG);
    const petItems = await itemsOf('petAreaBasedList2', GANGNEUNG);
    expect(withItems.length).toBeGreaterThan(0);
    expect(petItems.length).toBeGreaterThan(0);
    for (const i of [...withItems, ...petItems]) expect(i).toMatchObject(GANGNEUNG);
  });

  it('🔴 다른 지역의 무장애 목록은 강릉 스냅샷으로 대신하지 않는다 — 필터가 그럴듯하게 틀린다', async () => {
    await expect(transport.request('withAreaBasedList2', { lDongRegnCd: '11', lDongSignguCd: '110' }))
      .rejects.toBeInstanceOf(FixtureMissingError);
    await expect(transport.request('petAreaBasedList2', { lDongRegnCd: '51' })).rejects.toBeInstanceOf(FixtureMissingError);
  });

  it('상세는 본문 contentid 로 찾는다', async () => {
    expect((await itemsOf('detailWithTour2', { contentId: '129784' }))[0]?.contentid).toBe('129784');
    expect((await itemsOf('detailPetTour2', { contentId: '2628994' }))[0]?.contentid).toBe('2628994');
    await expect(transport.request('detailWithTour2', { contentId: '125790' })).rejects.toThrow(/보유 목록: 129784/);
  });

  it('🔴 연관 관광지는 키워드가 다르면 던진다 — 다른 기준 관광지의 순위를 붙이지 않는다', async () => {
    expect((await itemsOf('searchKeyword1', { keyword: '경포대', baseYm: '202608' })).length).toBeGreaterThan(0);
    await expect(transport.request('searchKeyword1', { keyword: '오죽헌', baseYm: '202608' }))
      .rejects.toBeInstanceOf(FixtureMissingError);
  });

  it('걷기 길은 전국 목록 하나다', async () => {
    expect((await itemsOf('courseList', { numOfRows: 1000, pageNo: 1 })).length).toBeGreaterThan(0);
  });

  it('🔴 방문자수는 기간까지 맞아야 돌려준다 — 다른 달 숫자가 T3 로 가면 안 된다', async () => {
    expect((await itemsOf('locgoRegnVisitrDDList', { startYmd: '20250901', endYmd: '20250901' })).length).toBeGreaterThan(0);
    await expect(transport.request('locgoRegnVisitrDDList', { startYmd: '20250901', endYmd: '20250930' }))
      .rejects.toBeInstanceOf(FixtureMissingError);
  });

  it('🔴 근처 3km 는 분류별 스냅샷을 돌려주고, 없는 분류는 섞인 목록으로 대신하지 않는다', async () => {
    const near = { mapX: 128.8947, mapY: 37.7517, radius: 3000 };
    const food = await itemsOf('locationBasedList2', { ...near, lclsSystm1: 'FD' });
    const lodging = await itemsOf('locationBasedList2', { ...near, lclsSystm1: 'AC' });
    expect(food.length).toBeGreaterThan(0);
    expect(food.every((i) => i.lclsSystm1 === 'FD')).toBe(true);
    expect(lodging.every((i) => i.lclsSystm1 === 'AC')).toBe(true);
    await expect(transport.request('locationBasedList2', { ...near, lclsSystm1: 'VE' })).rejects.toBeInstanceOf(FixtureMissingError);
    // 분류 없는 조회(수정안 후보)는 지금까지 쓰던 스냅샷 그대로다
    const mixed = await itemsOf('locationBasedList2', near);
    expect(new Set(mixed.map((i) => i.lclsSystm1)).size).toBeGreaterThan(1);
  });
});

describe('HttpKtoTransport', () => {
  const opts = { serviceKey: 'TEST-KEY-DO-NOT-LOG', fetchImpl: async () => new Response('{}') };

  it('인증키가 비어 있으면 생성 단계에서 막는다', () => {
    // 키 없이 호출하면 전부 인증 오류로 돌아와 원인이 흐려진다
    expect(() => new HttpKtoTransport({ serviceKey: '' })).toThrow(/인증키/);
  });

  it('공사 필수 공통 파라미터를 붙인다', async () => {
    let seen = '';
    const t = new HttpKtoTransport({
      ...opts,
      fetchImpl: async (url) => {
        seen = String(url);
        return new Response('{}');
      },
    });
    await t.request('searchKeyword2', { keyword: '강릉' });
    const parsed = new URL(seen);
    expect(parsed.pathname).toMatch(/\/searchKeyword2$/);
    expect(parsed.searchParams.get('_type')).toBe('json');
    expect(parsed.searchParams.get('MobileOS')).toBe('ETC');
    expect(parsed.searchParams.get('MobileApp')).toBe('TourLint');
    expect(parsed.searchParams.get('keyword')).toBe('강릉');
  });

  describe('서비스마다 베이스 URL 이 따로다 (외부 연동 3-1 · API 7-2)', () => {
    const seenUrl = async (operation: Parameters<HttpKtoTransport['request']>[0], extra: object = {}): Promise<URL> => {
      let seen = '';
      const t = new HttpKtoTransport({
        ...opts,
        ...extra,
        fetchImpl: async (url) => {
          seen = String(url);
          return new Response('{}');
        },
      });
      await t.request(operation, {});
      return new URL(seen);
    };

    it.each([
      ['areaBasedList2', 'https://apis.data.go.kr/B551011/KorService2/areaBasedList2'],
      ['withAreaBasedList2', 'https://apis.data.go.kr/B551011/KorWithService2/areaBasedList2'],
      ['detailWithTour2', 'https://apis.data.go.kr/B551011/KorWithService2/detailWithTour2'],
      ['petAreaBasedList2', 'https://apis.data.go.kr/B551011/KorPetTourService2/areaBasedList2'],
      ['detailPetTour2', 'https://apis.data.go.kr/B551011/KorPetTourService2/detailPetTour2'],
      ['searchKeyword1', 'https://apis.data.go.kr/B551011/TarRlteTarService1/searchKeyword1'],
      ['courseList', 'https://apis.data.go.kr/B551011/Durunubi/courseList'],
      ['locgoRegnVisitrDDList', 'https://apis.data.go.kr/B551011/DataLabService/locgoRegnVisitrDDList'],
    ] as const)('🔴 %s → %s', async (operation, expected) => {
      const url = await seenUrl(operation);
      expect(`${url.origin}${url.pathname}`).toBe(expected);
      // 새 서비스도 공통 파라미터는 같다
      expect(url.searchParams.get('_type')).toBe('json');
      expect(url.searchParams.get('MobileApp')).toBe('TourLint');
    });

    it('KTO_BASE_URL 은 국문 관광정보에만 적용한다', async () => {
      const proxy = { baseUrl: 'http://proxy.test/kor' };
      expect((await seenUrl('areaBasedList2', proxy)).href).toMatch(/^http:\/\/proxy\.test\/kor\/areaBasedList2\?/);
      expect((await seenUrl('withAreaBasedList2', proxy)).host).toBe('apis.data.go.kr');
    });
  });

  it('타임아웃은 KtoTimeoutError 로 확정한다', async () => {
    const t = new HttpKtoTransport({
      serviceKey: 'k',
      timeoutMs: 5,
      fetchImpl: async () => {
        const e = new Error('timed out');
        e.name = 'TimeoutError';
        throw e;
      },
    });
    await expect(t.request('detailCommon2', {})).rejects.toBeInstanceOf(KtoTimeoutError);
  });

  it('HTTP 오류에 응답 본문을 담지 않는다 — 원문 누출 경로다', async () => {
    const t = new HttpKtoTransport({
      serviceKey: 'k',
      fetchImpl: async () => new Response('강릉 오죽헌 운영시간 09:00~18:00', { status: 503 }),
    });
    const e = await t.request('detailIntro2', {}).catch((x: unknown) => x);
    expect((e as KtoFetchError).httpStatus).toBe(503);
    expect((e as Error).message).not.toContain('오죽헌');
  });

  describe('인증키가 오류·예외 어디에도 새지 않는다 (EI-CM-002 · NF-SC-009)', () => {
    const KEY = 'SUPER-SECRET-SERVICE-KEY';

    it('네트워크 오류 메시지에 없다', async () => {
      const t = new HttpKtoTransport({ serviceKey: KEY, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
      const e = await t.request('searchKeyword2', {}).catch((x: unknown) => x);
      expect(JSON.stringify({ m: (e as Error).message, s: (e as Error).stack })).not.toContain(KEY);
    });

    it('HTTP 오류 메시지에 없다', async () => {
      const t = new HttpKtoTransport({ serviceKey: KEY, fetchImpl: async () => new Response('e', { status: 500 }) });
      const e = await t.request('searchKeyword2', {}).catch((x: unknown) => x);
      expect((e as Error).message).not.toContain(KEY);
    });

    it('타임아웃 메시지에 없다', async () => {
      const t = new HttpKtoTransport({
        serviceKey: KEY,
        timeoutMs: 1,
        fetchImpl: async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; },
      });
      const e = await t.request('searchKeyword2', {}).catch((x: unknown) => x);
      expect((e as Error).message).not.toContain(KEY);
    });
  });
});
