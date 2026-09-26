import type { Endpoint, ErrorDoc, ParamDoc } from '../types';

/*
 * 2. 상품.
 *
 * 조회 예시는 운영 공용 계정의 상품 38 을 줄여 옮겼다. 쓰기 API 의 경로 번호에는 예시를 넣지
 * 않는다 — Try it out 이 예시 값을 미리 채우는데, 공용 계정이라 그대로 누르면 모두가 보는
 * 상품 38 이 바뀌거나 지워진다. 쓰기 예시는 새로 만든 상품(41)으로 든다.
 */

/** 없는 상품과 다른 계정의 상품을 가르지 않는다 — 둘 다 404 다 (EX-SY-003) */
export function productNotFound(productId: number): ErrorDoc {
  return {
    status: 404,
    reasonCode: 'NOT_FOUND',
    when: '없는 상품이거나 다른 계정의 상품',
    message: `상품을 찾을 수 없습니다 (#${String(productId)}).`,
    unit: 'PRODUCT',
  };
}

/** 쓰기 API 의 상품 번호. 예시를 넣지 않는다 (위 주석) */
export const OWN_PRODUCT: ParamDoc = {
  description: '상품 번호',
  type: 'integer',
};

const PRODUCT_38: ParamDoc = { description: '상품 번호', example: 38, type: 'integer' };

export const PRODUCTS: readonly Endpoint[] = [
  {
    route: 'POST /api/v1/products',
    tag: '상품',
    summary: '상품 만들기',
    description: '여행 지역 · 출발일 · 박수 · 이동수단 등으로 새 상품을 만듭니다. 일정을 함께 보내면 한 번에 저장합니다.',
    body: {
      example: {
        name: '강릉 감성 1박 2일',
        ldongRegnCd: '51',
        ldongSignguCd: '150',
        startDate: '2026-10-28',
        nights: 1,
        targetKey: 'YOUTH_20S',
        conceptKey: 'EMOTIONAL',
        headCount: 24,
        transport: 'CHARTER_BUS',
        planOrigin: { startedBy: 'TEXT' },
        days: [
          {
            day: 1,
            items: [
              {
                start: '10:00',
                end: '11:30',
                place: '강릉 경포대',
                itemType: 'SIGHT',
                origin: 'TEXT',
                content: {
                  contentId: '125790',
                  contentTypeId: 12,
                  lcls1: 'HS',
                  lcls2: 'HS01',
                  mapx: 128.896483966593,
                  mapy: 37.7955136762197,
                },
              },
              { start: '12:00', end: '13:00', place: '가람집옹심이', itemType: 'MEAL', origin: 'TEXT' },
            ],
          },
          { day: 2, items: [] },
        ],
      },
      required: ['name', 'ldongRegnCd', 'startDate', 'nights', 'transport'],
      fields: {
        name: '상품명',
        ldongRegnCd: '여행 지역 시도 코드(`GET /api/v1/ldong-codes`)',
        ldongSignguCd: '시군구 코드. 비우면 시도 전체',
        startDate: '출발일 YYYY-MM-DD',
        nights: '박수 — 0(당일) · 1(1박 2일) · 2(2박 3일)',
        targetKey: '타깃 — YOUTH_20S · ADULT_3040 · COUPLE · FAMILY_KIDS · SENIOR · GROUP · SOLO. 비우면 없음',
        conceptKey: '콘셉트 — EMOTIONAL · HEALING · GOURMET · ACTIVITY · HERITAGE · SCENERY · CRAFT · FESTIVAL · SHOPPING. 비우면 없음',
        headCount: '예상 인원. 1 이상',
        transport: '이동수단 — CHARTER_BUS(전세버스) · CAR(자가용) · PUBLIC_TRANSIT(대중교통)',
        planOrigin: '기획을 시작한 방법(선택)',
        'planOrigin.startedBy': 'MANUAL · UPLOAD · TEXT · SIGNAL',
        days: '일차별 일정. 배열 순서대로 1일차부터',
        'days.day': '일차. 배열 순서대로 1일차부터',
        'days.items': '그 날 일정 항목. 비워도 됩니다',
        'days.items.start': '시작 시각 HH:MM',
        'days.items.end': '종료 시각 HH:MM. 비워도 됩니다',
        'days.items.place': '장소명',
        'days.items.itemType': 'SIGHT(관광) · MEAL(식사) · LODGING(숙박) · REST(휴식) · MOVE(이동) · FREE(자유)',
        'days.items.origin': '그 줄이 들어온 경로 — MANUAL(직접 입력) · UPLOAD(엑셀) · TEXT(메모) · PICKER(장소 담기). 없으면 MANUAL',
        'days.items.content': '고른 관광지(선택)',
        'days.items.excluded': 'true 면 직접 정한 곳(검수 제외)으로 저장합니다. 고른 관광지가 있으면 무시. 걷기 길은 `{ walkId }` — 장소명은 저장하지 않습니다',
        'days.items.content.contentId': '관광지 번호',
        'days.items.content.contentTypeId': '관광지 유형 코드',
        'days.items.content.lcls1': '대분류 코드',
        'days.items.content.lcls2': '중분류 코드',
        'days.items.content.mapx': '경도',
        'days.items.content.mapy': '위도',
      },
    },
    responses: {
      201: {
        description: '성공',
        example: {
          productId: 41,
          name: '강릉 감성 1박 2일',
          startDate: '2026-10-28',
          nights: 1,
          dayCount: 2,
          releasedAt: null,
          createdAt: '2026-09-20T01:10:24.518Z',
        },
      },
    },
  },
  {
    route: 'GET /api/v1/products',
    tag: '상품',
    summary: '상품 목록',
    description:
      '내 상품 목록을 돌려줍니다. 상품마다 현재 일정의 검수 결과 요약과 알림 수가 함께 옵니다 — 확인하지 않은 알림(`unreadNotifications`) · 무시하지 않은 알림(`activeNotifications`) · 알림 뒤에 다시 검수하지 않은 바뀐 정보(`risksSinceAudit`). 여행이 끝난 상품의 알림 수는 0 입니다. `startedBy` 는 기획을 시작한 방법(MANUAL · UPLOAD · TEXT · SIGNAL)이고 기록이 없으면 null 입니다.',
    params: {
      page: { description: '쪽 번호. 0부터', example: 0, type: 'integer' },
      size: { description: '한 쪽에 담을 상품 수. 기본 20 · 최대 100', example: 20, type: 'integer' },
    },
    responses: {
      200: {
        description: '성공',
        example: {
          content: [
            {
              productId: 26,
              name: '제주 우천 리스크 검증 1박 2일',
              startDate: '2026-12-05',
              nights: 1,
              region: { regnName: '제주특별자치도', signguName: null },
              latestAudit: {
                auditRunId: 75,
                executedAt: '2026-09-17T12:59:28.861Z',
                readinessScore: 48,
                isPartial: false,
                counts: { blocker: 0, error: 3, warning: 4, unverified: 2 },
                releasable: true,
              },
              unreadNotifications: 0,
              activeNotifications: 0,
              risksSinceAudit: 0,
              pendingMatches: 0,
              plannedAt: '2026-09-17T12:59:28.751Z',
              releasedAt: null,
              startedBy: null,
            },
            '…외 8개',
          ],
          page: 0,
          size: 20,
          totalElements: 9,
          totalPages: 1,
        },
      },
    },
  },
  {
    route: 'GET /api/v1/products/{productId}',
    tag: '상품',
    summary: '상품 상세',
    description: '상품 정보와 일정 전체를 일차별로 돌려줍니다.',
    params: { productId: PRODUCT_38 },
    responses: {
      200: {
        description: '성공',
        example: {
          productId: 38,
          name: '[실습-가이드] 강릉 감성 2박 3일',
          region: { regnName: '강원특별자치도', signguName: '강릉시' },
          ldongRegnCd: '51',
          ldongSignguCd: '150',
          startDate: '2026-11-17',
          nights: 2,
          dayCount: 3,
          targetKey: 'YOUTH_20S',
          conceptKey: 'EMOTIONAL',
          headCount: 15,
          transport: 'CAR',
          releasedAt: '2026-09-19T14:34:38.147Z',
          plannedAt: '2026-09-19T13:36:33.287Z',
          planOrigin: null,
          composition: { manual: 11, picker: 3, excluded: 2 },
          createdAt: '2026-09-19T13:31:45.927Z',
          days: [
            {
              day: 1,
              items: [
                {
                  itemId: 337,
                  seq: 1,
                  start: '10:00',
                  end: '11:30',
                  place: '강릉 경포대',
                  itemType: 'SIGHT',
                  ktoContentId: '125790',
                  matchStatus: 'CONFIRMED',
                  mapx: 128.89648397,
                  mapy: 37.79551368,
                  walkId: null,
                  lcls2: 'HS01',
                  endTimeSource: 'INPUT',
                },
                {
                  itemId: 338,
                  seq: 2,
                  start: '12:00',
                  end: '13:30',
                  place: '강릉 오죽헌·시립박물관',
                  itemType: 'SIGHT',
                  ktoContentId: '129784',
                  matchStatus: 'CONFIRMED',
                  mapx: 128.8796621,
                  mapy: 37.77913887,
                  walkId: null,
                  lcls2: 'VE07',
                  endTimeSource: 'INPUT',
                },
              ],
            },
          ],
        },
      },
    },
    errors: [productNotFound(38)],
  },
  {
    route: 'PATCH /api/v1/products/{productId}',
    tag: '상품',
    summary: '상품 정보 수정',
    description: '상품명 · 출발일 · 타깃 · 콘셉트 · 인원 · 이동수단 중 보낸 항목만 수정합니다.',
    params: { productId: OWN_PRODUCT },
    body: {
      example: {
        name: '강릉 감성 1박 2일',
        startDate: '2026-11-04',
        targetKey: 'COUPLE',
        conceptKey: 'EMOTIONAL',
        headCount: 20,
        transport: 'CAR',
      },
      fields: {
        name: '상품명(필수)',
        startDate: '출발일 YYYY-MM-DD',
        targetKey: '타깃 키. null 이면 지웁니다',
        conceptKey: '콘셉트 키. null 이면 지웁니다',
        headCount: '예상 인원(1 이상). null 이면 지웁니다',
        transport: 'CHARTER_BUS · CAR · PUBLIC_TRANSIT',
      },
    },
    responses: {
      200: { description: '성공', example: { productId: 41, updated: true } },
    },
    errors: [productNotFound(41)],
  },
  {
    route: 'DELETE /api/v1/products/{productId}',
    tag: '상품',
    summary: '상품 삭제',
    description: '상품과 그 일정 · 검수 결과 · 알림을 함께 삭제합니다. 되돌릴 수 없습니다.',
    params: { productId: OWN_PRODUCT },
    responses: { 204: { description: '성공 (본문 없음)' } },
    errors: [productNotFound(41)],
  },
  {
    route: 'POST /api/v1/products/{productId}/handoff',
    tag: '상품',
    summary: '검수 시작',
    description: '기획을 마친 상품의 첫 검수를 요청합니다. 검수는 시간이 걸리므로 받은 작업 번호로 진행 상태를 확인합니다.',
    params: { productId: OWN_PRODUCT },
    body: {
      description: '생략할 수 있다',
      optional: true,
      example: { excludePending: true },
      fields: { excludePending: 'true 면 아직 고르지 않은 장소를 검수에서 빼고 시작' },
    },
    responses: {
      202: {
        description: '요청 접수',
        example: { productId: 41, plannedAt: '2026-09-20T01:32:10.512Z', jobId: 214, excludedCount: 1 },
      },
    },
    errors: [
      productNotFound(41),
      {
        status: 422,
        reasonCode: 'DAY_COUNT_MISMATCH',
        when: '일정이 없는 일차가 있음',
        message: '아직 일정이 없는 일차가 있습니다 (2일차). 모든 일차에 일정을 넣어야 검수를 시작할 수 있습니다.',
        unit: 'PRODUCT',
      },
      {
        status: 422,
        reasonCode: 'PLACE_UNRESOLVED',
        when: '아직 고르지 않은 장소가 있음',
        message: '아직 고르지 않은 장소가 1곳 있습니다. 장소를 고르거나 이대로 검수 시작을 눌러 주세요.',
        unit: 'PRODUCT',
      },
      {
        status: 429,
        reasonCode: 'BUDGET_EXHAUSTED',
        when: '오늘 관광정보 조회 한도를 다 씀',
        message: '오늘 쓸 수 있는 관광정보 조회를 모두 썼습니다. 내일 0시부터 다시 검수할 수 있고, 일정 편집과 지난 결과 보기는 지금도 할 수 있습니다.',
      },
      {
        status: 429,
        reasonCode: 'RATE_LIMIT_EXCEEDED',
        when: '1분에 5번을 넘김 — 다시 검수와 같이 센다. 공개 테스트 계정은 세지 않는다',
        message: '검수는 1분에 5번까지 요청할 수 있어요. 43초 뒤에 다시 눌러 주세요.',
      },
    ],
  },
];
