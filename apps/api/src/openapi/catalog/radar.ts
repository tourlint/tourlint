import type { Endpoint } from '../types';

/** 9. 레이더 */

const PRODUCT_NAME = '[실습-가이드] 강릉 감성 2박 3일';

/** 운영정보 지문(SHA-256) 전 → 후. 조건 2 · 3 알림은 둘 다 null 이다 */
const FINGERPRINT = {
  from: '66887186026e96b1b405fa383853ae55097fcce31473bece69b75fa951c8bb99',
  to: 'a2786b2d50ac7546c0ce3dda536635b74bcccec876fab170df4a5b64fda69590',
};

/** 관심 키워드 일치. [] 는 맞는 곳 없음, null 은 배치가 아직 안 본 키워드 */
const KEYWORD_HITS = [
  { keyword: '역사', contentIds: [] },
  { keyword: '커피', contentIds: null },
];

const REGION_SIGNALS = [
  {
    region: { regnCd: '51', signguCd: '150' },
    month: '2026-11',
    t1: {
      count: 1,
      byType: { '15': 1 },
      window: { from: '2026-08-21', to: '2026-09-19' },
      computedAt: '2026-09-19T14:41:00.492Z',
      keywordHits: KEYWORD_HITS,
    },
    t2: {
      count: 0,
      byType: {},
      window: { from: '2026-11-01', to: '2026-11-30' },
      computedAt: '2026-09-19T14:41:04.783Z',
      keywordHits: KEYWORD_HITS,
    },
    t3: {
      count: 8559848,
      basisMonth: '2025-11',
      source: '빅데이터 지역별 방문자수',
      computedAt: '2026-09-18T07:11:06.042Z',
    },
  },
];

const NOTIFICATION_NOT_FOUND = '알림을 찾을 수 없습니다. 목록을 새로 고쳐 주세요.';

export const RADAR: readonly Endpoint[] = [
  {
    route: 'GET /api/v1/radar/summary',
    tag: '레이더',
    summary: '레이더 요약',
    description: '바뀐 정보 · 새 소식 알림 수와 마지막 · 다음 자동 확인 시각을 돌려줍니다.',
    responses: {
      200: {
        description: '성공',
        example: {
          risk: 1,
          opportunity: 0,
          unread: 1,
          affectedProducts: 1,
          changedContents: 1,
          lastBatchAt: '2026-09-17T20:00:41.512Z',
          nextBatchAt: '2026-09-21T05:00:00+09:00',
          lastBatch: {
            runAt: '2026-09-17T20:00:41.512Z',
            covered: '2026-09-17',
            status: 'OK',
            itemCount: 412,
          },
        },
      },
    },
  },
  {
    route: 'GET /api/v1/radar/changes',
    tag: '레이더',
    summary: '바뀐 정보 목록',
    description: '상품에 넣은 관광지의 정보가 바뀐 내역을 최신순으로 돌려줍니다.',
    params: {
      page: { description: '쪽 번호. 0부터', type: 'integer', example: 0 },
      size: { description: '한 쪽 개수. 기본 20 · 최대 100', type: 'integer', example: 20 },
    },
    responses: {
      200: {
        description: '성공',
        example: {
          content: [
            {
              notificationId: 57,
              productId: 38,
              productName: PRODUCT_NAME,
              ktoContentId: '129784',
              placeLabel: '강릉 오죽헌·시립박물관',
              condition: 1,
              hidden: false,
              what: '일정에 포함된 관광지의 운영정보가 바뀌었습니다.',
              detectedAt: '2026-09-17T20:00:41.512Z',
              modifiedTime: '20260917143012',
              fingerprint: FINGERPRINT,
              readableChanges: [{ label: '운영시간', before: '09:00~18:00', after: '09:00~17:00' }],
              hasReadableDiff: true,
            },
          ],
          page: 0,
          size: 20,
          totalElements: 1,
        },
      },
    },
  },
  {
    route: 'GET /api/v1/radar/signals',
    tag: '레이더',
    summary: '수요 신호',
    description: '상품 지역에 새로 등록된 관광지 수와 여행 기간 중 행사 수를 돌려줍니다. 판매량을 예측하지 않습니다.',
    params: {
      productId: { description: '상품 번호', required: true, type: 'integer', example: 38 },
    },
    responses: {
      200: {
        description: '성공',
        example: {
          productId: 38,
          t1: {
            count: 1,
            byType: { '15': 1 },
            window: { from: '2026-08-21', to: '2026-09-19' },
            computedAt: '2026-09-19T14:41:00.492Z',
            keywordHits: KEYWORD_HITS,
          },
          t2: {
            count: 0,
            byType: {},
            window: { from: '2026-11-14', to: '2026-11-22' },
            computedAt: '2026-09-19T14:41:04.590Z',
          },
          notice: '관측된 건수와 유형 분포입니다. 판매량 · 흥행을 예측하지 않습니다.',
        },
      },
    },
    errors: [
      {
        status: 404,
        reasonCode: 'NOT_FOUND',
        when: '상품이 없거나 다른 계정의 상품',
        message: '상품을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.',
      },
    ],
  },
  {
    route: 'GET /api/v1/radar/signals/detail',
    tag: '레이더',
    summary: '수요 신호 — 무엇인지',
    description: '건수가 가리키는 곳을 이름과 날짜로 돌려줍니다. 세는 조회를 한 번 더 부르며 이름은 저장하지 않습니다.',
    params: {
      productId: { description: '상품 번호', required: true, type: 'integer', example: 38 },
      type: { description: 'T1(새로 등록된 곳) 또는 T2(여행일에 열리는 행사)', required: true, type: 'string', example: 'T2' },
    },
    responses: {
      200: {
        description: '성공. 목록을 못 받으면 `items` 가 비고 `unavailable` 에 이유가 들어갑니다',
        example: {
          productId: 38,
          type: 'T2',
          window: { from: '2026-10-20', to: '2026-10-26' },
          items: [{
            contentId: '825295',
            title: '강릉커피축제',
            contentTypeId: '15',
            createdDate: '2026-02-18',
            eventStart: '2026-10-21',
            eventEnd: '2026-10-25',
          }],
          unavailable: null,
        },
      },
    },
    errors: [
      {
        status: 404,
        reasonCode: 'NOT_FOUND',
        when: '상품이 없거나 다른 계정의 상품',
        message: '상품을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.',
      },
    ],
  },
  {
    route: 'GET /api/v1/radar/region-signals/detail',
    tag: '레이더',
    summary: '관심 지역 새 소식 — 무엇인지',
    description: '관심 지역 카드의 건수가 가리키는 곳을 이름과 날짜로 돌려줍니다. 본인 관심 지역만 답합니다.',
    params: {
      regnCd: { description: '시도 코드', required: true, type: 'string', example: '51' },
      signguCd: { description: '시군구 코드. 비우면 시도 전체', required: false, type: 'string', example: '150' },
      month: { description: '관심 지역의 달 `YYYY-MM`', required: true, type: 'string', example: '2026-11' },
      type: { description: 'T1(새로 등록된 곳) 또는 T2(그 달 행사)', required: true, type: 'string', example: 'T1' },
    },
    responses: {
      200: {
        description: '성공. 목록을 못 받으면 `items` 가 비고 `unavailable` 에 이유가 들어갑니다',
        example: {
          region: { regnCd: '51', signguCd: '150' },
          month: '2026-11',
          type: 'T1',
          window: { from: '2026-08-21', to: '2026-09-19' },
          items: [{
            contentId: '3568894',
            title: '강릉 솔향수목원 야간개장',
            contentTypeId: '12',
            createdDate: '2026-09-12',
            eventStart: null,
            eventEnd: null,
          }],
          unavailable: null,
        },
      },
    },
    errors: [
      {
        status: 404,
        reasonCode: 'NOT_FOUND',
        when: '내 관심 지역이 아닌 지역 · 달',
        message: '관심 지역에서 찾을 수 없습니다. 목록에서 다시 선택해 주세요.',
      },
    ],
  },
  {
    route: 'GET /api/v1/radar/region-signals',
    tag: '레이더',
    summary: '관심 지역 소식',
    description: '관심 지역마다 새로 등록된 곳 · 그 달의 행사 · 지난해 같은 달 방문자 수를 돌려줍니다.',
    responses: {
      200: { description: '성공', example: REGION_SIGNALS },
    },
  },
  {
    route: 'POST /api/v1/radar/region-signals/refresh',
    tag: '레이더',
    summary: '관심 지역 소식 새로 확인',
    description: '관심 지역 소식을 지금 다시 확인합니다. 매일 자동 확인이 꺼져 있을 때만 쓸 수 있습니다.',
    responses: {
      200: { description: '성공', example: REGION_SIGNALS },
    },
    errors: [
      {
        status: 403,
        reasonCode: 'FORBIDDEN_ACTION',
        when: '매일 자동 확인이 켜져 있음',
        message: '평일 아침마다 자동으로 새로 확인하고 있어요. 지금 확인은 자동 확인이 꺼져 있을 때만 쓸 수 있어요.',
      },
      {
        status: 429,
        reasonCode: 'BUDGET_EXHAUSTED',
        when: '오늘 관광정보 조회 한도를 다 씀',
        message: '오늘 사용할 수 있는 관광정보 조회량을 모두 썼습니다. 내일 다시 확인해 주세요.',
      },
    ],
  },
  {
    route: 'POST /api/v1/radar/today',
    tag: '레이더',
    summary: '오늘 할 일 (AI)',
    description: '바뀐 정보와 관심 지역 소식을 오늘 할 일 목록으로 정리합니다. 저장하지 않습니다. `action` 은 `REAUDIT`(다시 검수) · `VIEW_RESULT`(바뀐 뒤 이미 다시 검수함 — 검수 결과 보기) · `NEW_PLAN`(이 지역으로 새 상품 기획)입니다.',
    responses: {
      200: {
        description: '성공',
        example: {
          basisAt: '2026-09-17T20:00:41.512Z',
          todos: [
            {
              kind: 'CHANGE',
              productId: 38,
              region: null,
              reason: '11월 17일 출발 상품이에요. 일정의 강릉 오죽헌·시립박물관 정보가 바뀌었어요.',
              action: 'REAUDIT',
            },
            {
              kind: 'NEWS',
              productId: null,
              region: { regnCd: '51', signguCd: '150', month: '2026-11' },
              reason: '2026-11 관심 지역에 최근 30일 동안 새로 등록된 곳이 1곳 있어요.',
              action: 'NEW_PLAN',
            },
          ],
          quiet: [{ productId: 26, text: '제주 우천 리스크 검증 1박 2일은 바뀐 정보가 없어요.' }],
          incomplete: null,
        },
      },
    },
    errors: [
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
    route: 'GET /api/v1/notifications',
    tag: '레이더',
    summary: '알림 목록',
    description: '바뀐 정보 · 새 소식 알림을 최신순으로 돌려줍니다. 문장(`what` · `impact`)은 저장하지 않고 볼 때 사실로 만듭니다 — `schedule`(일정에 든 줄) · `changes`(알림 직전 검수와 알림 뒤 첫 검수의 판독 결과 차이) · `current`(견줄 이전 검수가 없을 때의 지금 값) · `modifiedOn`(관광정보 수정일) · `eventPeriod` · `overlapDays`(겹치는 여행 일차). `placeName` 은 사용자가 일정에 적은 이름이 먼저이고, 일정에 없는 곳만 볼 때 읽습니다. 표출이 중단된 곳과 못 읽은 곳은 `null` 입니다.',
    params: {
      kind: {
        description: '`RISK` 바뀐 정보 · `OPPORTUNITY` 새 소식. 없으면 둘 다',
        enum: ['RISK', 'OPPORTUNITY'],
        example: 'RISK',
      },
      unread: { description: '`true` 면 안 읽은 알림만', type: 'boolean' },
      includeDismissed: { description: '`true` 면 무시한 알림도 함께', type: 'boolean' },
      productId: { description: '이 상품의 알림만', type: 'integer', example: 38 },
      page: { description: '쪽 번호. 0부터', type: 'integer', example: 0 },
      size: { description: '한 쪽 개수. 기본 20 · 최대 100', type: 'integer', example: 20 },
    },
    responses: {
      200: {
        description: '성공',
        example: {
          content: [
            {
              notificationId: 57,
              kind: 'RISK',
              condition: 1,
              productId: 38,
              productName: PRODUCT_NAME,
              startDate: '2026-11-17',
              ktoContentId: '129784',
              placeName: '오죽헌',
              schedule: { dayNo: 1, startTime: '12:00' },
              changes: [{ label: '운영시간', before: '09:00~18:00', after: '09:00~17:00' }],
              current: [],
              modifiedOn: '2026-09-17',
              eventPeriod: null,
              overlapDays: [],
              what: '운영시간 정보가 바뀌었습니다.',
              impact: '1일차 12:00 일정입니다.',
              action: '다시 검수해 판정을 갱신하세요.',
              hidden: false,
              fingerprint: FINGERPRINT,
              dismissable: true,
              readAt: null,
              dismissedAt: null,
              createdAt: '2026-09-17T20:00:41.512Z',
            },
          ],
          page: 0,
          size: 20,
          totalElements: 1,
          unreadCount: 1,
        },
      },
    },
  },
  {
    route: 'POST /api/v1/notifications/{id}/read',
    tag: '레이더',
    summary: '알림 읽음 표시',
    description: '알림을 읽음으로 표시합니다.',
    params: {
      id: { description: '알림 번호', type: 'integer' },
    },
    responses: {
      200: { description: '성공', example: { id: 57, readAt: '2026-09-20T01:12:09.331Z' } },
    },
    errors: [
      { status: 404, reasonCode: 'NOT_FOUND', when: '알림이 없거나 다른 계정의 알림', message: NOTIFICATION_NOT_FOUND },
    ],
  },
  {
    route: 'POST /api/v1/notifications/{id}/dismiss',
    tag: '레이더',
    summary: '알림 넘기기',
    description: '알림을 목록에서 뺍니다. 삭제하지는 않습니다.',
    params: {
      id: { description: '알림 번호', type: 'integer' },
    },
    responses: {
      200: { description: '성공', example: { id: 57, dismissedAt: '2026-09-20T01:12:31.904Z' } },
    },
    errors: [
      {
        status: 403,
        reasonCode: 'FORBIDDEN_ACTION',
        when: '표출이 중단된 관광지의 알림(`dismissable: false`)',
        message: '표출이 중단된 관광지 알림은 무시할 수 없습니다. 출시 불가 사유이므로 다른 관광지로 대체하거나 일정에서 빼 주세요.',
      },
      { status: 404, reasonCode: 'NOT_FOUND', when: '알림이 없거나 다른 계정의 알림', message: NOTIFICATION_NOT_FOUND },
    ],
  },
];
