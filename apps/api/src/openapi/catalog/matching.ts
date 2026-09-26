import { EXTERNAL_UNAVAILABLE_MESSAGE } from '@tourlint/shared';
import type { Endpoint } from '../types';

/** 4. 장소 연결 */

const BUDGET_MESSAGE =
  '오늘 쓸 수 있는 관광정보 조회를 모두 썼습니다. 내일 0시부터 다시 볼 수 있고, 일정 입력과 저장은 지금도 할 수 있습니다.';

export const MATCHING: readonly Endpoint[] = [
  {
    route: 'GET /api/v1/contents/search',
    tag: '관광지 연결',
    summary: '관광지 검색',
    description: '이름으로 한국관광공사 관광정보에서 관광지를 찾습니다. 지역 코드를 주면 그 지역 안에서만 찾습니다.',
    params: {
      keyword: { description: '찾을 장소 이름', required: true, example: '경포해수욕장' },
      regnCd: { description: '시도 코드. 주면 그 지역 안에서만 찾습니다', example: '51' },
      signguCd: { description: '시군구 코드', example: '150' },
      page: { description: '쪽 번호. 0부터', type: 'integer' },
      size: { description: '한 쪽 건수. 기본 20 · 최대 50', type: 'integer', example: 3 },
    },
    responses: {
      200: {
        description: '성공',
        example: {
          regionFilterApplied: true,
          fetchedAt: '2026-09-19T15:08:45.575Z',
          candidates: [
            {
              contentid: '128758',
              title: '경포해수욕장',
              addr1: '강원특별자치도 강릉시 창해로 514 (안현동)',
              contenttypeid: 12,
              lDongRegnCd: '51',
              lDongSignguCd: '150',
              cpyrhtDivCd: 'Type1',
            },
          ],
          totalCount: 1,
          source: '출처: ⓒ한국관광공사',
        },
      },
    },
    errors: [
      { status: 400, reasonCode: 'INPUT_INVALID', when: '`keyword` 가 비어 있음', message: '검색어를 입력해 주세요.' },
      {
        status: 503,
        reasonCode: 'KTO_FETCH_FAILED',
        when: '관광정보를 불러오지 못함',
        message: EXTERNAL_UNAVAILABLE_MESSAGE,
      },
    ],
  },
  {
    route: 'POST /api/v1/items/{itemId}/match',
    tag: '관광지 연결',
    summary: '관광지 연결',
    description: '일정 항목을 검색에서 고른 관광지와 연결합니다. 연결된 장소만 운영시간 · 휴무일을 검수합니다.',
    params: {
      itemId: { description: '일정 항목 번호', type: 'integer' },
    },
    body: {
      example: { contentid: '129784', matchedBy: 'USER' },
      required: ['contentid'],
      fields: {
        contentid: '고른 관광지 번호(`GET /api/v1/contents/search` 결과)',
        matchedBy: '고른 방법 — `USER`(기본) · `AUTO` · `AGENT`',
      },
    },
    responses: {
      200: {
        description: '성공',
        example: {
          itemId: 338,
          matchStatus: 'CONFIRMED',
          content: {
            contentid: '129784',
            title: '강릉 오죽헌·시립박물관',
            addr1: '강원특별자치도 강릉시 율곡로3139번길 24 (죽헌동)',
            contenttypeid: 14,
            lclsSystm1: 'VE',
            lclsSystm2: 'VE07',
            lclsSystm3: 'VE070100',
            mapx: 128.87966210169768,
            mapy: 37.779138874844655,
            cpyrhtDivCd: 'Type1',
          },
          fetchedAt: '2026-09-20T01:23:45.678Z',
          // Type3 이면 note 가 '변경금지', 그 밖에는 null
          sourceBadge: { type: 'KTO_RAW', note: null },
        },
      },
    },
    errors: [
      { status: 400, reasonCode: 'INPUT_INVALID', when: '본문의 `contentid` 가 비어 있음', message: 'contentid 가 필요합니다.', unit: 'ITEM' },
      {
        status: 400,
        reasonCode: 'CONTENT_NOT_FOUND',
        when: '고른 관광지의 정보를 읽지 못함',
        message: '선택한 관광지 정보를 가져오지 못했습니다.',
        unit: 'ITEM',
      },
      { status: 404, reasonCode: 'NOT_FOUND', when: '없는 항목이거나 다른 계정의 항목', message: '항목을 찾을 수 없습니다 (#338).', unit: 'ITEM' },
      {
        status: 503,
        reasonCode: 'CONTENT_NOT_FOUND',
        when: '없는 관광지 번호',
        message: EXTERNAL_UNAVAILABLE_MESSAGE,
      },
      {
        status: 503,
        reasonCode: 'KTO_FETCH_FAILED',
        when: '관광정보를 불러오지 못함',
        message: EXTERNAL_UNAVAILABLE_MESSAGE,
      },
    ],
  },
  {
    route: 'POST /api/v1/items/{itemId}/exclude',
    tag: '관광지 연결',
    summary: '직접 정한 곳으로 두기',
    description: '관광정보에서 찾을 수 없는 장소를 일정에 그대로 두고 검수에서만 뺍니다.',
    params: {
      itemId: { description: '일정 항목 번호', type: 'integer' },
    },
    responses: {
      200: { description: '성공', example: { itemId: 352, matchStatus: 'EXCLUDED' } },
    },
    errors: [
      { status: 404, reasonCode: 'NOT_FOUND', when: '없는 항목이거나 다른 계정의 항목', message: '항목을 찾을 수 없습니다 (#352).', unit: 'ITEM' },
    ],
  },
  {
    route: 'POST /api/v1/products/{productId}/place-suggestions',
    tag: '관광지 연결',
    summary: 'AI 장소 추천',
    description: '아직 관광지를 고르지 않은 일정 항목마다 AI 가 알맞은 관광지를 추천합니다. 추천만 하고 일정은 바꾸지 않습니다.',
    params: {
      productId: { description: '상품 번호', type: 'integer', example: 38 },
    },
    body: {
      example: { itemIds: [352, 353, 354] },
      fields: {
        itemIds: '추천받을 일정 항목 번호. 빼면 전부',
      },
    },
    responses: {
      200: {
        description: '성공',
        example: {
          items: [
            {
              itemId: 352,
              kind: 'FOUND',
              place: {
                contentId: '125790',
                contentTypeId: 12,
                title: '강릉 경포대',
                kindName: '역사유적지',
                addr: '강원특별자치도 강릉시 경포로 365',
              },
              alternatives: [
                { contentId: '2721547', title: '호린파크(경포대허브농장)', kindName: '산업관광', distanceM: 7371 },
              ],
              reason: '이름이 같은 관광지이고 앞 일정 오죽헌에서 2.3km 거리예요.',
            },
            {
              itemId: 353,
              kind: 'NO_NAME',
              place: null,
              alternatives: [],
              reason: '장소 이름이 없는 줄이라 찾지 않았어요. 장소 찾기로 직접 고르거나 직접 정한 곳으로 두세요.',
            },
          ],
          summary: { found: 1, notFound: 0, noName: 1 },
          incomplete: { reasonCode: 'LLM_UNAVAILABLE', itemIds: [354] },
        },
      },
    },
    errors: [
      { status: 404, reasonCode: 'NOT_FOUND', when: '없는 상품이거나 다른 계정의 상품', message: '상품을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.' },
      { status: 429, reasonCode: 'BUDGET_EXHAUSTED', when: '오늘 관광정보 조회 한도를 다 씀', message: BUDGET_MESSAGE },
      {
        status: 429,
        reasonCode: 'RATE_LIMIT_EXCEEDED',
        when: '같은 계정에서 이미 실행 중',
        message: '이미 정리하고 있어요. 끝나면 다시 눌러 주세요.',
      },
      {
        status: 429,
        reasonCode: 'RATE_LIMIT_EXCEEDED',
        when: '1분에 5번을 넘김',
        message: '짧은 시간에 너무 많이 눌렀어요. 잠시 뒤에 다시 눌러 주세요.',
      },
    ],
  },
  {
    route: 'GET /api/v1/contents/{contentId}',
    tag: '관광지 연결',
    summary: '관광지 상세',
    description: '관광지의 공식 명칭 · 문의처 · 운영시간 등을 한국관광공사에서 조회해 돌려줍니다.',
    params: {
      contentId: { description: '관광지 번호', example: '129784' },
      contentTypeId: {
        description: '관광지 유형 코드 — 12 관광지 · 14 문화시설 · 15 행사 · 28 레포츠 · 32 숙박 · 38 쇼핑 · 39 음식점',
        type: 'integer',
        example: 14,
      },
      with: { description: '함께 받을 정보 — `accessible`(무장애) · `pet`(반려동물), 쉼표로 여러 개', example: 'accessible,pet' },
    },
    responses: {
      200: {
        description: '성공',
        example: {
          contentId: '129784',
          fetchedAt: '2026-09-19T15:08:46.681Z',
          hidden: false,
          officialName: '강릉 오죽헌·시립박물관',
          homepageUrl: 'http://www.gn.go.kr/museum/',
          contact: { tel: '033-660-3301~8' },
          ktoRaw: {
            restdateculture: '연중무휴(1월 1일/설날/추석 당일은 오죽헌만 개방, 실내 전시실 휴관)',
            usetimeculture: '매표시간 09:00~17:00 관람시간 09:00~18:00',
          },
          ktoModifiedTime: '20260318101005',
          unavailableReason: null,
          contentTypeId: 14,
          mapx: 128.87966210169768,
          mapy: 37.779138874844655,
          lclsSystm1: 'VE',
          lclsSystm2: 'VE07',
          lclsSystm3: 'VE070100',
          cpyrhtDivCd: 'Type1',
          accessible: {
            route: '출입구까지 경사로가 설치되어 있음',
            wheelchair: '대여 가능(5대/매표소 발권 후 우측에 보관함)',
            elevator: '엘리베이터 있음',
            restroom: '장애인 화장실 있음',
          },
          pet: null,
        },
      },
    },
  },
];
