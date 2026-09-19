import { EXTERNAL_UNAVAILABLE_MESSAGE } from '@tourlint/shared';
import type { Endpoint, ErrorDoc, ParamDoc } from '../types';

/** 5. 기획 · 장소 담기 */

const BUDGET_EXHAUSTED: ErrorDoc = {
  status: 429,
  reasonCode: 'BUDGET_EXHAUSTED',
  when: '오늘 관광정보 조회 한도를 다 씀',
  message:
    '오늘 쓸 수 있는 관광정보 조회를 모두 썼습니다. 내일 0시부터 다시 볼 수 있고, 일정 입력과 저장은 지금도 할 수 있습니다.',
};

const KTO_FAILED: ErrorDoc = {
  status: 503,
  reasonCode: 'KTO_FETCH_FAILED',
  when: '관광정보를 불러오지 못함',
  message: EXTERNAL_UNAVAILABLE_MESSAGE,
};

const REGN_CD: ParamDoc = { description: '시도 코드', required: true, example: '51' };
const SIGNGU_CD: ParamDoc = { description: '시군구 코드', example: '150' };

export const PLANNING: readonly Endpoint[] = [
  {
    route: 'GET /api/v1/plan/briefing',
    tag: '장소 찾기',
    summary: '지역 요약',
    description: '지역의 관광지 종류별 등록 수와 여행 기간 중 행사 수를 돌려줍니다.',
    params: {
      regnCd: REGN_CD,
      signguCd: SIGNGU_CD,
      startDate: { description: '출발일 `YYYY-MM-DD`', required: true, example: '2026-11-17' },
      nights: { description: '박 수 0 ~ 30. 기본 0', type: 'integer', example: 2 },
      extraLcls2: { description: '더 볼 분류 코드(쉼표로 여러 개)' },
    },
    responses: {
      200: {
        description: '성공',
        example: {
          region: { regnCd: '51', signguCd: '150', name: '강릉시' },
          types: [
            { kind: 'LCLS2', lcls2: 'VE01', nearKind: null, name: '랜드마크관광', count: 6, disabled: null },
            { kind: 'LCLS2', lcls2: 'NA02', nearKind: null, name: '자연경관(하천‧해양)', count: 34, disabled: null },
            '…외 4개',
          ],
          events: { count: 0, from: '2026-11-14', to: '2026-11-22' },
          accessible: { count: 727 },
          pet: { count: 110 },
          walks: { count: 4 },
          budget: 'OK',
        },
      },
    },
    errors: [BUDGET_EXHAUSTED],
  },
  {
    route: 'GET /api/v1/plan/places',
    tag: '장소 찾기',
    summary: '장소 목록',
    description: '지역 안의 장소를 종류별로 20곳씩 돌려줍니다. 기준 장소 근처 3km 안의 식당 · 카페 · 숙소도 찾을 수 있습니다.',
    params: {
      regnCd: REGN_CD,
      signguCd: SIGNGU_CD,
      scope: { description: '`SIGNGU` 시군구 전체(기본) · `NEAR3KM` 기준 장소 근처 3km', enum: ['SIGNGU', 'NEAR3KM'] },
      lcls2: { description: '분류 코드. `SIGNGU` 일 때 필수', example: 'VE07' },
      nearKind: { description: '`NEAR3KM` 일 때 필수. 식당 · 카페 · 숙소', enum: ['MEAL', 'CAFE', 'STAY'] },
      sort: { description: '`near` 가까운 순 · `together` 함께 많이 가는 순', enum: ['near', 'together'] },
      anchor: { description: '기준 좌표 `경도,위도`' },
      anchorContentId: { description: '기준 관광지 번호' },
      wheelchair: { description: '`1` 이면 휠체어 가능한 곳만' },
      pet: { description: '`1` 이면 반려동물 동반 가능한 곳만' },
      indoor: { description: '`1` 이면 실내인 곳만' },
      page: { description: '쪽 번호. 1부터 · 한 쪽 20곳', type: 'integer', example: 1 },
    },
    responses: {
      200: {
        description: '성공',
        example: {
          scope: { kind: 'SIGNGU', label: '강릉시 전체' },
          totalCount: 25,
          items: [
            {
              contentId: '129784',
              contentTypeId: 14,
              lcls1: 'VE',
              lcls2: 'VE07',
              lcls2Name: '전시시설',
              title: '강릉 오죽헌·시립박물관',
              addr1: '강원특별자치도 강릉시 율곡로3139번길 24 (죽헌동)',
              firstImage: 'https://tong.visitkorea.or.kr/cms/resource/38/3527138_image2_1.jpg',
              mapx: 128.87966210169768,
              mapy: 37.779138874844655,
              distanceM: null,
              togetherRank: null,
              wheelchair: true,
              pet: false,
              indoorOutdoor: 'INDOOR',
            },
          ],
          disabled: null,
          notice: null,
        },
      },
    },
    errors: [BUDGET_EXHAUSTED, KTO_FAILED],
  },
  {
    route: 'GET /api/v1/plan/place-detail',
    tag: '장소 찾기',
    summary: '장소 상세',
    description: '장소의 이용시간 · 쉬는 날 · 요금 · 주차 정보를 돌려줍니다.',
    params: {
      contentId: { description: '관광지 번호', required: true, example: '129784' },
      contentTypeId: {
        description: '관광지 유형 코드 — 12 관광지 · 14 문화시설 · 15 행사 · 28 레포츠 · 32 숙박 · 38 쇼핑 · 39 음식점',
        required: true,
        type: 'integer',
        example: 14,
      },
    },
    responses: {
      200: {
        description: '성공',
        example: {
          contentId: '129784',
          hours: '매표시간 09:00~17:00 관람시간 09:00~18:00',
          restDays: '연중무휴(1월 1일/설날/추석 당일은 오죽헌만 개방, 실내 전시실 휴관)',
          fee: '어른 개인 3,000원 / 청소년 2,000원 / 어린이 1,000원',
          parking: null,
          eventPeriod: null,
        },
      },
    },
    errors: [BUDGET_EXHAUSTED],
  },
  {
    route: 'GET /api/v1/plan/events',
    tag: '장소 찾기',
    summary: '행사 · 공연 목록',
    description: '여행 기간 앞뒤로 그 지역에서 열리는 축제 · 공연을 기간과 함께 돌려줍니다.',
    params: {
      regnCd: REGN_CD,
      signguCd: SIGNGU_CD,
      startDate: { description: '출발일 `YYYY-MM-DD`', required: true, example: '2026-10-15' },
      nights: { description: '박 수 0 ~ 30. 기본 0', type: 'integer', example: 1 },
    },
    responses: {
      200: {
        description: '성공',
        example: {
          window: { from: '2026-10-12', to: '2026-10-19' },
          items: [
            {
              contentId: '825295',
              contentTypeId: 15,
              title: '강릉커피축제',
              eventStart: '2026-10-21',
              eventEnd: '2026-10-25',
              relation: 'AFTER',
              suggestedStartDate: '2026-10-21',
              firstImage: 'https://tong.visitkorea.or.kr/cms/resource/24/3546224_image2_1.JPG',
              mapx: 128.9473094259,
              mapy: 37.7726104945,
            },
          ],
        },
      },
    },
    errors: [BUDGET_EXHAUSTED, KTO_FAILED],
  },
  {
    route: 'GET /api/v1/plan/walks',
    tag: '장소 찾기',
    summary: '걷기 길 목록',
    description: '지역의 걷기 길(두루누비) 코스를 길이 · 걸리는 시간과 함께 돌려줍니다.',
    params: {
      regnCd: REGN_CD,
      signguCd: SIGNGU_CD,
    },
    responses: {
      200: {
        description: '성공',
        example: {
          items: [
            { walkId: 'T_CRS_MNG0000004219', name: '해파랑길 39코스 바우길 05구간', lengthKm: 16, minutes: 330, level: 1 },
          ],
          notice: '넣으면 직접 정한 곳으로 들어가요.',
        },
      },
    },
  },
  {
    route: 'POST /api/v1/products/{productId}/place-facts',
    tag: '장소 찾기',
    summary: '일정 장소 정보',
    description: '일정에 넣은 관광지마다 이용시간 · 쉬는 날 · 앞 장소에서 오는 이동시간을 돌려줍니다. 저장하지 않습니다.',
    params: {
      productId: { description: '상품 번호', type: 'integer', example: 38 },
    },
    body: {
      example: { itemIds: [338] },
      fields: { itemIds: '볼 일정 항목 번호. 빼면 전부' },
    },
    responses: {
      200: {
        description: '성공',
        example: {
          items: [
            {
              itemId: 338,
              name: '강릉 오죽헌·시립박물관',
              kindName: '전시시설',
              hours: '매표시간 09:00~17:00 관람시간 09:00~18:00',
              restDays: '연중무휴(1월 1일/설날/추석 당일은 오죽헌만 개방, 실내 전시실 휴관)',
              fee: '어른 개인 3,000원 / 청소년 2,000원 / 어린이 1,000원',
              parking: null,
              eventPeriod: null,
              travelFromPrevMinutes: 11,
              matchedBy: 'USER',
              origin: 'MANUAL',
            },
          ],
        },
      },
    },
    errors: [
      { status: 404, reasonCode: 'NOT_FOUND', when: '없는 상품이거나 다른 계정의 상품', message: '상품을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.' },
      BUDGET_EXHAUSTED,
    ],
  },
];
