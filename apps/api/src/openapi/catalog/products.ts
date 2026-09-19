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
  description: '직접 만든 상품의 번호. 테스트 계정은 여럿이 함께 쓰니 다른 사람이 보는 상품은 바꾸지 않는다',
  type: 'integer',
};

const PRODUCT_38: ParamDoc = { description: '상품 번호 — 목록의 `productId`', example: 38, type: 'integer' };

export const PRODUCTS: readonly Endpoint[] = [
  {
    route: 'POST /api/v1/products',
    tag: '2. 상품',
    summary: '새 상품 저장',
    description: [
      '기본정보 · 상품 성격 · 이동수단으로 상품을 만든다. 일정(`days`)을 함께 보내면 한 번에 저장한다. ' +
        '만든 상품은 **기획 중**(`plannedAt: null`)이고 검수는 돌지 않는다 — 검수는 `POST /api/v1/products/{productId}/handoff` 가 시작한다.',
      '',
      '- 일정은 비워 두거나 일부 일차만 채워도 된다. `days` 는 배열 순서가 곧 1일차 · 2일차다(`day` 값은 읽지 않는다).',
      '- 항목에 `content`(목록에서 고른 장소)가 있으면 연결된 장소(`CONFIRMED`)로, 없으면 고를 곳(`PENDING`)으로 저장한다. 장소명은 입력한 그대로 저장한다.',
      '- `end` 를 비우면 종료 시각 없이 저장하고, 검수 때 표준 체류시간으로 채워 본다.',
      '- `planOrigin` 은 시작 방식 · 신호 종류 · 지역 코드 · 기간 · contentId 만 남긴다. 모양이 틀리면 버리고 상품은 그대로 만든다.',
      '- 입력이 틀리면 400 이다. 틀린 곳을 모두 이어 한 문장으로 알려 준다(예: 박수 3, 목록에 없는 타깃 키, 박수를 넘는 일차에 넣은 항목).',
    ].join('\n'),
    screen: '새 상품 기획 › 저장하고 장소 고르기',
    calls: '없음 — DB 에 쓴다',
    spec: 'FR-CM-006 · FR-IN-004 · 007 · 008 · FR-PL-001 · 020 · API 설계 4-2 · 5-1',
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
        planOrigin: { startedBy: 'MANUAL' },
        days: [
          {
            day: 1,
            items: [
              {
                start: '10:00',
                end: '11:30',
                place: '강릉 경포대',
                itemType: 'SIGHT',
                content: {
                  contentId: '125790',
                  contentTypeId: 12,
                  lcls1: 'HS',
                  lcls2: 'HS01',
                  mapx: 128.896483966593,
                  mapy: 37.7955136762197,
                },
              },
              { start: '12:00', end: '13:00', place: '가람집옹심이', itemType: 'MEAL' },
            ],
          },
          { day: 2, items: [] },
        ],
      },
      required: ['name', 'ldongRegnCd', 'startDate', 'nights', 'transport'],
      fields: {
        name: '상품명',
        ldongRegnCd: '여행 지역(시도) 법정동 코드 — `GET /api/v1/ldong-codes`',
        ldongSignguCd: '시군구 법정동 코드 — `GET /api/v1/ldong-codes?regnCd=51`. 비우면 시도 전체',
        startDate: '출발일 YYYY-MM-DD',
        nights: '박수 — 0(당일) · 1(1박 2일) · 2(2박 3일)',
        targetKey: '타깃 — YOUTH_20S · ADULT_3040 · COUPLE · FAMILY_KIDS · SENIOR · GROUP · SOLO. 비우면 없음',
        conceptKey: '콘셉트 — EMOTIONAL · HEALING · GOURMET · ACTIVITY · HERITAGE · SCENERY · CRAFT · FESTIVAL · SHOPPING. 비우면 없음',
        headCount: '예상 인원. 1 이상',
        transport: '이동수단 — CHARTER_BUS(전세버스) · CAR(자가용) · PUBLIC_TRANSIT(대중교통)',
        planOrigin: '기획 출처. 레이더 신호에서 시작했으면 `signal{type, regnCd, signguCd, from, to, contentId?}` 를 더한다',
        'planOrigin.startedBy': 'MANUAL · UPLOAD · TEXT · CLONE · SIGNAL',
        days: '일차별 일정. 배열 순서가 1일차부터다',
        'days.day': '읽지 않는다 — 일차는 배열 순서로 정한다',
        'days.items': '그 날 항목. 비워도 된다',
        'days.items.start': '시작 시각 HH:MM',
        'days.items.end': '종료 시각 HH:MM. 비우면 검수 때 표준 체류시간으로 채워 본다',
        'days.items.place': '장소명',
        'days.items.itemType': 'SIGHT(관광) · MEAL(식사) · LODGING(숙박) · REST(휴식) · MOVE(이동) · FREE(자유)',
        'days.items.content': '목록에서 고른 장소. 코드 · 분류 · 좌표만 받고 제목 · 주소는 받지 않는다',
        'days.items.content.contentId': '관광정보 콘텐츠 ID',
        'days.items.content.contentTypeId': '관광 타입 ID',
        'days.items.content.lcls1': '대분류 코드',
        'days.items.content.lcls2': '중분류 코드',
        'days.items.content.mapx': '경도',
        'days.items.content.mapy': '위도',
      },
    },
    responses: {
      201: {
        description: '만든 상품. 일정 항목의 번호는 `GET /api/v1/products/{productId}` 로 본다',
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
    tag: '2. 상품',
    summary: '상품 목록',
    description: [
      '로그인한 계정의 상품을 출발일이 늦은 순으로 돌려준다. 상품마다 지금 일정의 검수 요약(`latestAudit` — 출시 준비도 · 등급별 건수 · 출시 가능 여부), ' +
        '안 읽은 알림 수, 아직 고르지 않은 장소 수가 붙는다.',
      '',
      '- 화면은 이 응답으로 칸을 나눈다 — `plannedAt` 이 null 이면 기획 중, `releasedAt` 이 있으면 출시함, 그 밖에는 최신 검수에 차단이 없으면 출시할 수 있음, 아니면 검수 중.',
      '- `latestAudit` 은 보통 가장 최근 검수다. 수정안을 되돌렸으면 되돌린 일정의 검수(반영 전)다 — 가장 최근 검수가 지금 일정과 다르기 때문이다. 검수한 적이 없으면 null 이다.',
      '- `releasable` 은 출시 승인이 통과할지다(`POST /api/v1/products/{productId}/release` 와 같은 판정). 수정안을 반영하고 재검수가 끝나기 전에는 false 다.',
      '- `page` 는 0부터, `size` 는 기본 20 · 최대 100 이다. 숫자가 아니거나 음수면 기본값으로 본다.',
      '- 지역 이름을 읽지 못하면 이름 자리에 코드를 그대로 싣는다.',
    ].join('\n'),
    screen: '홈 · 기획 · 검수 · 레이더 — 화면을 열 때',
    calls: '지역 이름을 붙이는 법정동 코드 조회(공사)뿐 — 서버가 뜬 뒤 시도 목록 1콜, 시도마다 시군구 목록 1콜을 처음 한 번만 부르고 메모리에 둔다',
    spec: 'FR-CM-005 · FR-PL-001 · API 설계 4-2 · 5-2',
    params: {
      page: { description: '쪽 번호. 0부터', example: 0, type: 'integer' },
      size: { description: '한 쪽에 담을 상품 수. 기본 20 · 최대 100', example: 20, type: 'integer' },
    },
    responses: {
      200: {
        description: '상품 목록. 예시는 운영 공용 계정의 응답을 줄였다',
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
              pendingMatches: 0,
              plannedAt: '2026-09-17T12:59:28.751Z',
              releasedAt: null,
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
    tag: '2. 상품',
    summary: '상품 상세 · 일정 전체',
    description: [
      '상품 기본정보와 일정 전체를 일차별로 묶어 돌려준다. 기획 화면 · 검수 결과 · 일정 편집이 이 응답으로 화면을 그린다.',
      '',
      '- `days` 에는 항목이 있는 일차만 들어가고, 항목은 순번 순이다. 일차 수는 `dayCount` 로 본다.',
      '- `plannedAt` 이 null 이면 기획 중이다. `composition` 은 항목 구성 — 직접 입력(`manual`) · 장소 담기(`picker`) · 검수 제외(`excluded`) 건수다.',
      '- 장소 담기 · 걷기 길로 넣은 항목과 수정안으로 장소가 바뀐 항목은 `place` 를 응답할 때 관광정보에서 찾아 채운다. 이 이름은 저장하지 않고, 못 찾으면 지어내지 않는다.',
      '- 검수 결과는 담지 않는다. 검수 이력은 `GET /api/v1/products/{productId}/audit-runs` 로 읽는다.',
      '- 다른 계정의 상품이면 404 다.',
    ].join('\n'),
    screen: '기획 화면 · 검수 결과 · 일정 편집 — 화면을 열 때',
    calls:
      '표시용 조회만 — 지역 이름(법정동 코드, 처음 한 번), 이름을 채울 항목의 명칭(공사 공통정보 1곳당 1콜), ' +
      '걷기 길 이름(두루누비 1콜). 명칭은 10분 동안 메모리에만 둔다',
    spec: 'FR-CM-006 · FR-PL-020 · API 설계 4-2',
    params: { productId: PRODUCT_38 },
    responses: {
      200: {
        description: '상품 상세. 예시는 운영 상품 38 이고 `days` 는 1일차 앞 두 항목만 남겼다',
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
    tag: '2. 상품',
    summary: '상품 기본정보 수정',
    description: [
      '상품명 · 출발일 · 타깃 · 콘셉트 · 예상 인원 · 이동수단 가운데 보낸 필드만 고친다.',
      '',
      '- `startDate` 를 바꾸는 것은 **출발일 옮기기**다. 일정 항목의 시각은 그대로 둔다.',
      '- 여행 지역과 박수는 바꿀 수 없다 — 보내도 무시한다.',
      '- `targetKey` · `conceptKey` · `headCount` 는 null 이나 빈 문자열을 보내면 지운다.',
      '- 검수는 다시 돌지 않는다. 바뀐 조건으로 보려면 검수를 다시 요청한다(`POST /api/v1/products/{productId}/audit-jobs`).',
      '- 입력이 틀리면 400(빈 상품명 · 날짜 형식 · 목록에 없는 타깃 · 콘셉트 · 이동수단 · 1 미만 인원), 다른 계정의 상품이면 404 다.',
    ].join('\n'),
    screen: '일정 편집 › 저장, 기획 화면 › 장소 담기 › 행사 · 공연 › 출발일을 ○월 ○일로',
    calls: '없음 — DB 에 쓴다',
    spec: 'FR-CM-006 · FR-PL-014 · PM-NG-011 · API 설계 4-2',
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
        name: '상품명. 비울 수 없다',
        startDate: '출발일 YYYY-MM-DD. 항목 시각은 그대로다',
        targetKey: '타깃 키. null 이면 지운다',
        conceptKey: '콘셉트 키. null 이면 지운다',
        headCount: '예상 인원. 1 이상, null 이면 지운다',
        transport: 'CHARTER_BUS · CAR · PUBLIC_TRANSIT',
      },
    },
    responses: {
      200: { description: '고쳤다', example: { productId: 41, updated: true } },
    },
    errors: [productNotFound(41)],
  },
  {
    route: 'DELETE /api/v1/products/{productId}',
    tag: '2. 상품',
    summary: '상품 삭제',
    description: [
      '상품을 지운다. 일정 항목, 검수 작업 · 검수 결과(발견 항목 · 데이터 지문 포함), 수정안 반영 이력, 알림이 함께 지워지고 **되돌릴 수 없다.**',
      '',
      '- 화면은 확인 창을 거친 뒤 부른다. API 는 부르는 즉시 지운다.',
      '- 외부 호출 기록은 하루 예산 집계에 그대로 남는다.',
      '- 다른 계정의 상품이면 404 다.',
    ].join('\n'),
    screen: '홈 · 기획 · 검수 › 삭제 › 상품 삭제, 일정 편집 › 상품 삭제 › 삭제',
    calls: '없음 — DB 에서 지운다',
    spec: 'FR-CM-006 · DR-LC-002 · EX-MS-006 · API 설계 4-2',
    params: { productId: OWN_PRODUCT },
    responses: { 204: { description: '지웠다' } },
    errors: [productNotFound(41)],
  },
  {
    route: 'POST /api/v1/products/{productId}/handoff',
    tag: '2. 상품',
    summary: '검수 시작',
    description: [
      '기획 중인 상품을 검수로 넘기고 첫 검수를 요청한다. 검수 시작 시각(`plannedAt`)을 남기고 검수는 비동기로 돈다 — ' +
        '받은 `jobId` 로 `GET /api/v1/audit-jobs/{jobId}` 를 불러 진행을 본다.',
      '',
      '- 모든 일차에 일정이 한 줄 이상 있어야 한다. 빈 일차가 있으면 422 `DAY_COUNT_MISMATCH` 다.',
      '- 고르지 않은 장소(`PENDING`)가 남았으면 422 `PLACE_UNRESOLVED` 다. `{"excludePending": true}` 를 보내면 남은 곳을 검수 제외로 바꾸고 넘긴다 — 바꾼 수가 `excludedCount` 다.',
      '- 오늘 공사 조회 예산을 다 썼으면 429 다. 방금 바꾼 것을 모두 되돌려 상품은 기획 중에 남는다.',
      '- 이미 넘긴 상품이면 처음 시각을 그대로 두고 검수만 다시 요청한다. 도는 검수가 있으면 새로 만들지 않고 그 작업 번호를 준다.',
      '- 본문은 생략할 수 있다(`{}` 와 같다).',
    ].join('\n'),
    screen: '기획 화면 › 검수 시작 › 검수 시작(고르지 않은 곳이 있으면 이대로 검수 시작)',
    calls:
      '요청은 DB 만 쓴다. 뒤이어 도는 검수가 공사 관광정보(1박 2일 8곳 약 29콜) · 카카오모빌리티 · 기상청을 부른다 — ' +
      '검수 요청(`POST /api/v1/products/{productId}/audit-jobs`)과 같다',
    spec: 'FR-PL-001 · EX-AU-001 · API 설계 4-2',
    params: { productId: OWN_PRODUCT },
    body: {
      description: '생략할 수 있다',
      optional: true,
      example: { excludePending: true },
      fields: { excludePending: 'true 면 고르지 않은 장소를 검수 제외로 바꾸고 넘긴다. 그 밖의 값은 false 로 본다' },
    },
    responses: {
      202: {
        description: '검수를 요청했다',
        example: { productId: 41, plannedAt: '2026-09-20T01:32:10.512Z', jobId: 214, excludedCount: 1 },
      },
    },
    errors: [
      productNotFound(41),
      {
        status: 422,
        reasonCode: 'DAY_COUNT_MISMATCH',
        when: '일정이 없는 일차가 있음(`fieldErrors` 의 `missingDays` 에 그 일차)',
        message: '아직 일정이 없는 일차가 있습니다 (2일차). 모든 일차에 일정을 넣어야 검수를 시작할 수 있습니다.',
        unit: 'PRODUCT',
      },
      {
        status: 422,
        reasonCode: 'PLACE_UNRESOLVED',
        when: '고르지 않은 장소가 남았는데 `excludePending` 이 아님(`fieldErrors` 의 `pendingCount` 에 곳 수)',
        message: '아직 고르지 않은 장소가 1곳 있습니다. 장소를 고르거나 이대로 검수 시작을 눌러 주세요.',
        unit: 'PRODUCT',
      },
      {
        status: 429,
        reasonCode: 'BUDGET_EXHAUSTED',
        when: '오늘 공사 조회 예산을 다 씀(상품은 기획 중에 남는다)',
        message: '오늘 사용할 수 있는 공사 데이터 조회량을 모두 썼습니다. 내일 다시 시도하거나 관리자에게 예산 상향을 요청해 주세요.',
      },
    ],
  },
];
