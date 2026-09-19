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
    tag: '9. 레이더',
    summary: '레이더 현황',
    description: [
      '레이더 위쪽 숫자 — 바뀐 정보 · 새 소식 알림 수와 마지막 · 다음 확인 시각을 돌려준다.',
      '',
      '- 알림은 배치가 평일 아침(운영자가 정한 시각, 기본 05:00 KST)에 만들어 둔다. 이 요청은 저장된 값을 읽기만 한다. 주말에 바뀐 것은 월요일 배치가 이어서 본다.',
      '- **여행 마지막 날(출발일 + 박수)이 한국 날짜로 지난 상품의 알림은 세지 않는다.** 무시한 알림도 세지 않는다.',
      '- `unread` 는 안 읽은 알림 수, `affectedProducts` · `changedContents` 는 알림이 걸린 상품 · 관광지 수다.',
      '- `nextBatchAt` 은 다음 평일 배치 시각(한국 시간)이고, 배치가 꺼져 있으면 `null` 이다.',
      '- `lastBatch` 는 마지막 변경 확인 결과다. `covered` 는 확인을 마친 날짜, `status` 는 `OK` · `EMPTY`(어제가 평일인데 공사 변경 목록이 0건이라 다음 배치가 그날을 다시 본다. 주말 · 공휴일의 0건은 넘어간다) · `FAILED` · `HIDDEN_OVERFLOW` 다.',
    ].join('\n'),
    screen: '레이더 — 위쪽 바뀐 정보 · 새 소식 건수와 확인 시각',
    calls: '없음 — DB 만 읽는다',
    spec: 'FR-MO-050 · FR-MO-018 · NF-OB-004 · API 설계 4-8',
    responses: {
      200: {
        description: '레이더 현황',
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
    tag: '9. 레이더',
    summary: '바뀐 정보 목록',
    description: [
      '배치가 감지한 관광정보 변경을 알림 한 건씩 최신순으로 돌려준다. 알림 목록(`GET /notifications`)과 달리 일정에 적은 장소 이름과 판독 결과 변화를 함께 싣는다.',
      '',
      '- `readableChanges` 는 휴무일 · 운영시간 · 입장마감 · 입실 · 퇴실 가운데 바뀐 것이다. 그 관광지를 두 번 이상 검수했을 때만 비교할 수 있다 — `hasReadableDiff: false` 면 비교할 이전 값이 없다는 뜻이지 바뀐 것이 없다는 뜻이 아니다.',
      '- `fingerprint` 는 운영정보 지문(SHA-256)의 전 → 후다. 일정 밖 관광지의 알림(조건 2 · 3)은 지문 이력이 없어 둘 다 `null` 이다.',
      '- 장소 이름은 사용자가 일정에 적은 `placeLabel` 이다. 공사 원문을 싣지 않는다.',
      '- 여행 마지막 날이 지난 상품과 무시한 알림은 빠진다. `page` · `size` 가 틀리면 400 이다.',
    ].join('\n'),
    calls: '없음 — DB 만 읽는다',
    spec: 'FR-MO-006 · 058 · FR-MO-018 · API 설계 4-8',
    params: {
      page: { description: '0부터 센다. 기본 0', type: 'integer', example: 0 },
      size: { description: '1 ~ 100. 기본 20', type: 'integer', example: 20 },
    },
    responses: {
      200: {
        description: '변경 내역 한 페이지',
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
    tag: '9. 레이더',
    summary: '수요 신호',
    description: [
      '상품 하나의 지역 · 여행 기간을 기준으로 수요 신호 T1 · T2 를 돌려준다. **판매량이나 흥행을 예측하지 않는다** — 관측된 건수와 유형 분포뿐이고 점수를 만들지 않는다.',
      '',
      '- T1 — 상품 지역에 새로 등록된 관광정보 수(가장 최근에 센 30일). `keywordHits` 는 이 계정의 관심 키워드마다 이름이 맞는 곳의 contentId 목록이다. 건수는 키워드로 거르지 않는다.',
      '- T2 — 여행 기간 앞뒤 3일 안에 그 지역에서 열리는 행사 수.',
      '- `byType` 은 관광정보 유형 코드별 건수(예: `15` 축제 · 공연 · 행사), `window` 는 센 기간이다.',
      '- 배치가 미리 세어 둔 값을 읽는다. 아직 세지 않았으면 `null` 이다 — 0 은 「세어 보니 없었다」, `null` 은 「아직 안 셌다」. `contentIds: null` 은 등록한 뒤 배치가 아직 안 본 키워드다.',
      '- `productId` 가 없거나 양의 정수가 아니면 400 이다. T2 기간이 그 상품의 여행일에서 나온다.',
    ].join('\n'),
    screen: '레이더 › 수요 신호 › 상품 선택',
    calls: '없음 — DB 만 읽는다(배치가 세어 둔 값)',
    spec: 'FR-RU-110 · 112 · 120 ~ 122 · FR-MO-053 · 055 · 056 · API 설계 4-8',
    params: {
      productId: { description: '신호를 볼 상품', required: true, type: 'integer', example: 38 },
    },
    responses: {
      200: {
        description: '그 상품의 T1 · T2',
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
    route: 'GET /api/v1/radar/region-signals',
    tag: '9. 레이더',
    summary: '관심 지역 새 소식',
    description: [
      '이 계정이 등록한 관심 지역(시군구 + 달)마다 새 소식 세 가지를 돌려준다 — T1 새로 등록된 곳, T2 그 달에 열리는 행사, T3 지난해 같은 달 방문자 수.',
      '',
      '- 배치가 미리 세어 둔 값을 읽기만 한다. 아직 세지 않은 칸은 `null` 이다(0 이 아니다).',
      '- T1 은 가장 최근에 센 30일, T2 는 그 달 1일 ~ 말일이다. 둘 다 이 계정의 관심 키워드 일치(`keywordHits`)가 붙는다.',
      '- T3 는 관측된 방문자 수(날마다 현지인 · 외지인 · 외국인을 더한 값)와 기준 달 · 출처뿐이다. **인기나 예측으로 쓰지 않는다.** 시군구 단위로 맞출 수 없는 지역(시도만 고른 곳 · 지난해 지역 코드와 이어지지 않는 곳)은 늘 `null` 이다.',
      '- 관심 지역이 없으면 빈 배열이다. 같은 지역 · 같은 달은 한 칸으로 합친다.',
    ].join('\n'),
    screen: '레이더 — 관심 지역 카드 · 새 소식 확인(자동 확인이 켜져 있을 때)',
    calls: '없음 — DB 만 읽는다',
    spec: 'FR-MO-059 · 060 · FR-RU-112 · API 설계 4-8',
    responses: {
      200: { description: '관심 지역마다 T1 · T2 · T3', example: REGION_SIGNALS },
    },
  },
  {
    route: 'POST /api/v1/radar/region-signals/refresh',
    tag: '9. 레이더',
    summary: '관심 지역 새 소식 지금 확인',
    description: [
      '관심 지역 새 소식을 지금 세고 `GET /radar/region-signals` 와 같은 모양으로 돌려준다. **자동 확인(배치)이 꺼진 기간에만** 쓴다.',
      '',
      '- 배치가 켜져 있으면 403 이다. `GET /radar/summary` 의 `nextBatchAt` 이 `null` 이 아니면 켜진 것이고, 그때는 `GET /radar/region-signals` 로 배치가 센 값을 읽는다.',
      '- 사용자가 누른 요청이라 예산 100% 까지 허용한다. 국문 관광정보 예산이 이미 다 찼으면 부르기 전에 429 이고, 세는 도중에 다 차면 거기서 멈추고 그때까지 저장된 값을 돌려준다.',
      '- 방문자수 예산만 막히면 T3 만 새로 세지 못하고 나머지는 돌려준다. 한 지역을 못 읽어도 다른 지역은 센다.',
      '- 오늘 이미 센 T1 · T2 와 이미 있는 T3 는 다시 부르지 않는다. 여러 번 눌러도 호출이 늘지 않는다.',
    ].join('\n'),
    screen: '레이더 › 새 소식 확인 (자동 확인이 꺼져 있을 때)',
    calls:
      '한국관광공사 — T1 `areaBasedList2` 는 지역마다, T2 `searchFestival2` 는 관심 지역(지역 + 달)마다 1콜(목록이 길면 페이지마다 1콜 더, 최대 5페이지), ' +
      'T3 `locgoRegnVisitrDDList` 는 같은 달 지역을 묶어 1콜. 예산은 국문 관광정보 · 방문자수 각 100% 까지',
    spec: 'FR-MO-059 · FR-OP-004 · API 설계 4-8 · 8-2',
    responses: {
      200: { description: '다시 센 관심 지역 새 소식 — `GET /radar/region-signals` 와 같은 모양', example: REGION_SIGNALS },
    },
    errors: [
      {
        status: 403,
        reasonCode: 'FORBIDDEN_ACTION',
        when: '자동 확인(배치)이 켜져 있음',
        message: '평일 아침마다 자동으로 새로 확인하고 있어요. 지금 확인은 자동 확인이 꺼져 있을 때만 쓸 수 있어요.',
      },
      {
        status: 429,
        reasonCode: 'BUDGET_EXHAUSTED',
        when: '국문 관광정보 오늘 예산을 다 씀(100%)',
        message: '오늘 사용할 수 있는 관광정보 조회량을 모두 썼습니다. 내일 다시 확인해 주세요.',
      },
    ],
  },
  {
    route: 'POST /api/v1/radar/today',
    tag: '9. 레이더',
    summary: '오늘 할 일 (AI)',
    description: [
      '레이더의 바뀐 정보와 관심 지역 새 소식을 오늘 할 일 목록으로 정리한다. AI 는 할 일마다 이유 한 줄만 쓴다.',
      '',
      '- **대상과 순서는 서버가 정한다** — 출발일이 가까운 상품의 바뀐 정보(`CHANGE` → 다시 검수)가 먼저, 관심 지역 새 소식(`NEWS` → 이 지역으로 새 상품 기획)이 다음이다. AI 는 순서 · 개수 · 대상을 바꾸지 못하고, 넘겨받지 않은 상품의 줄은 서버가 버린다.',
      '- 여행이 끝나지 않은 상품만 본다. 바뀐 정보가 없는 상품은 `quiet` 에 한 줄로 적는다. 아직 세지 않았거나 0건인 관심 지역은 새 소식으로 치지 않는다.',
      '- 목록만 정리한다. 재검수를 대신 돌리거나 기획 초안을 만들지 않고 결과를 저장하지 않는다 — 버튼은 사람이 누른다.',
      '- AI 가 실패하거나 30초를 넘기면 200 으로 끝난 줄만 싣고 `incomplete` 를 채운다. AI 키가 없는 서버도 같다(`LLM_UNAVAILABLE`).',
      '- 공사를 부르지 않아 예산으로 막히지 않는다. 같은 계정에서 이미 도는 중이거나 1분에 5번을 넘기면 429 다. `basisAt` 은 마지막 배치 시각이다(없으면 지금).',
    ].join('\n'),
    screen: '레이더 › 오늘 할 일 › 오늘 할 일 보기',
    calls: '공사 0콜 · AI(LLM) — 모델 호출 보통 2번(후보 받기 → 답 내기), 30초 상한. 볼 상품도 새 소식도 없으면 부르지 않는다',
    spec: 'FR-AG-030 · 031 · FR-AG-002 · FR-MO-018 · API 설계 4-11 · 3-4',
    responses: {
      200: {
        description: '오늘 할 일. `incomplete` 가 있으면 일부만 정리된 것이다',
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
        when: '같은 계정에서 이미 정리하는 중 — `Retry-After` 없음',
        message: '이미 정리하고 있어요. 끝나면 다시 눌러 주세요.',
      },
      {
        status: 429,
        reasonCode: 'RATE_LIMIT_EXCEEDED',
        when: '1분에 5번을 넘김 — `Retry-After` 헤더에 남은 초',
        message: '짧은 시간에 너무 많이 눌렀어요. 잠시 뒤에 다시 눌러 주세요.',
      },
    ],
  },
  {
    route: 'GET /api/v1/notifications',
    tag: '9. 레이더',
    summary: '알림 목록',
    description: [
      '바뀐 정보(`RISK`) · 새 소식(`OPPORTUNITY`) 알림을 최신순으로 돌려준다. 알림은 평일 아침 배치가 검수를 시작한 상품을 대상으로 만들고, 이 요청은 읽기만 한다.',
      '',
      '- `condition` 은 알림을 만든 조건이다. 1 일정에 넣은 관광지의 운영정보 변경 · 2 같은 시군구 관광지의 변경(여행일이 감지일 ±7일 안) · 3 여행일과 겹치는 행사의 변경이 바뀐 정보이고, 4 ~ 6 은 새로 등록된 관광지를 알리는 새 소식이다.',
      '- 새 소식은 같은 시군구에 **새로 등록된** 곳만 알린다 — 4 상품 구성에서 비어 있다고 본 유형 · 5 빈 시간대에 들어감 · 6 동선에서 5km 안쪽. 배치 한 번에 상품당 3건까지이고 4 를 먼저 남기며, 같은 곳은 한 상품에 한 번만 권한다.',
      '- **여행 마지막 날(출발일 + 박수)이 한국 날짜로 지난 상품의 알림은 빠진다.** 기록은 지우지 않는다.',
      '- 무시한 알림은 기본으로 빠지고 `includeDismissed=true` 로 다시 볼 수 있다. `unreadCount` 는 필터와 상관없는 안 읽은 알림 수다.',
      '- `what` · `impact` · `action` 은 서버가 조건으로 만든 문장이다. 관광지 이름은 싣지 않는다 — 화면은 `ktoContentId` 로 자기 일정의 장소 이름을 붙인다.',
      '- `dismissable: false` 는 표출이 중단된 관광지의 알림(`hidden: true`)이다. 무시할 수 없다.',
    ].join('\n'),
    screen: '레이더 › 바뀐 정보 · 새 소식 탭',
    calls: '없음 — DB 만 읽는다',
    spec: 'FR-MO-033 · 035 · 036 · 037 · FR-MO-018 · API 설계 4-8',
    params: {
      kind: {
        description: '`RISK` 바뀐 정보 · `OPPORTUNITY` 새 소식. 없으면 둘 다. 다른 값은 400',
        enum: ['RISK', 'OPPORTUNITY'],
        example: 'RISK',
      },
      unread: { description: '`true` 면 안 읽은 알림만', type: 'boolean' },
      includeDismissed: { description: '`true` 면 무시한 알림도 함께', type: 'boolean' },
      productId: { description: '이 상품의 알림만', type: 'integer', example: 38 },
      page: { description: '0부터 센다. 기본 0', type: 'integer', example: 0 },
      size: { description: '1 ~ 100. 기본 20', type: 'integer', example: 20 },
    },
    responses: {
      200: {
        description: '알림 한 페이지',
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
              what: '일정에 포함된 관광지의 운영정보가 바뀌었습니다.',
              impact: '휴무일 · 운영시간이 달라졌다면 기존 검수 결과가 더 이상 맞지 않습니다.',
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
    tag: '9. 레이더',
    summary: '알림 읽음 표시',
    description: [
      '알림 하나를 읽음으로 표시한다. 처음 읽은 시각을 남기고, 다시 불러도 그 시각을 덮어쓰지 않는다.',
      '',
      '- 자기 계정 상품의 알림만 바꿀 수 있다. 다른 계정의 알림과 없는 알림은 똑같이 404 다.',
      '- 읽음은 `GET /notifications` 의 `readAt` · `unreadCount` 와 레이더 현황의 `unread` 에 반영된다.',
    ].join('\n'),
    calls: '없음 — DB 만 쓴다',
    spec: 'FR-CM-005 · API 설계 4-8',
    params: {
      id: { description: '`GET /notifications` 의 `notificationId`', type: 'integer' },
    },
    responses: {
      200: { description: '읽음으로 표시됨', example: { id: 57, readAt: '2026-09-20T01:12:09.331Z' } },
    },
    errors: [
      { status: 404, reasonCode: 'NOT_FOUND', when: '알림이 없거나 다른 계정의 알림', message: NOTIFICATION_NOT_FOUND },
    ],
  },
  {
    route: 'POST /api/v1/notifications/{id}/dismiss',
    tag: '9. 레이더',
    summary: '알림 무시 (나중에)',
    description: [
      '알림 하나를 무시한다(화면의 「나중에」). 목록 · 건수에서 빠질 뿐 지워지지 않는다 — `GET /notifications?includeDismissed=true` 로 다시 볼 수 있다.',
      '',
      '- **표출이 중단된 관광지의 알림은 무시할 수 없다.** 출시할 수 없는 사유라 403 이다. 목록에서 `dismissable: false` 인 알림이다.',
      '- 같은 변경은 다시 알리지 않는다. 그 관광지에 새 변경이 생기면 새 알림으로 온다.',
      '- 이미 무시한 알림을 다시 불러도 처음 시각이 남는다. 다른 계정의 알림과 없는 알림은 404 다.',
    ].join('\n'),
    screen: '레이더 › 알림 카드 › 나중에',
    calls: '없음 — DB 만 쓴다',
    spec: 'FR-MO-036 · 037 · PM-NG-010 · EX-MO-010 · API 설계 4-8',
    params: {
      id: { description: '`GET /notifications` 의 `notificationId`', type: 'integer' },
    },
    responses: {
      200: { description: '무시됨', example: { id: 57, dismissedAt: '2026-09-20T01:12:31.904Z' } },
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
