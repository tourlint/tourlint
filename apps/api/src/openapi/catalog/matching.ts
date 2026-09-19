import { EXTERNAL_UNAVAILABLE_MESSAGE } from '@tourlint/shared';
import type { Endpoint } from '../types';

/** 4. 장소 연결 */

const BUDGET_MESSAGE =
  '오늘 쓸 수 있는 관광정보 조회를 모두 썼습니다. 내일 0시부터 다시 볼 수 있고, 일정 입력과 저장은 지금도 할 수 있습니다.';

export const MATCHING: readonly Endpoint[] = [
  {
    route: 'GET /api/v1/contents/search',
    tag: '4. 장소 연결',
    summary: '장소 검색',
    description: [
      '장소 이름으로 한국관광공사 관광정보를 찾아 후보(이름 · 주소 · 유형)를 돌려준다. 일정의 장소 칸에 이름을 적으면 부르고, ' +
        '사용자가 후보를 고르면 `POST /items/{itemId}/match` 로 연결한다.',
      '',
      '- `regnCd`(필요하면 `signguCd` 까지)를 주면 그 지역 안에서만 찾고 `regionFilterApplied` 가 `true` 다. 결과 건수에 따라 지역 조건을 켜고 끄지 않는다.',
      '- 후보의 이름 · 주소는 공사 원문이라 **응답으로만 흐르고 저장하지 않는다.**',
      '- `page` 는 0부터, `size` 는 기본 20 · 최대 50 이다. 숫자가 아니거나 음수면 기본값으로 본다. `totalCount` 는 공사가 알려 준 전체 건수다.',
    ].join('\n'),
    screen: '기획 › 장소 칸에 이름 입력 · 새 상품 기획 › 장소명 입력 · 장소 확인',
    calls: '공사 searchKeyword2 1콜 · 캐시 없음 · 예산 게이트를 거치지 않는다',
    spec: 'FR-IN-020 · FR-IN-022 · FR-IN-023 · FR-PL-004 · UI-S2-020 · API 설계 4-4 · 5-3',
    params: {
      keyword: { description: '찾을 장소 이름', required: true, example: '경포해수욕장' },
      regnCd: { description: '시도 코드(법정동). 주면 그 지역 안에서만 찾는다', example: '51' },
      signguCd: { description: '시군구 코드 3자리. `regnCd` 와 함께 준다', example: '150' },
      page: { description: '쪽 번호. 0부터', type: 'integer' },
      size: { description: '한 쪽 건수. 기본 20 · 최대 50', type: 'integer', example: 3 },
    },
    responses: {
      200: {
        description: '후보 목록',
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
      { status: 400, reasonCode: 'NOT_FOUND', when: '`keyword` 가 비어 있음', message: '검색어를 입력해 주세요.' },
      {
        status: 503,
        reasonCode: 'KTO_FETCH_FAILED',
        when: '공사 검색이 재시도 뒤에도 실패함 — 인증 · 한도 문제면 `KTO_AUTH_ERROR` · `KTO_QUOTA_EXCEEDED`',
        message: EXTERNAL_UNAVAILABLE_MESSAGE,
      },
    ],
  },
  {
    route: 'POST /api/v1/items/{itemId}/match',
    tag: '4. 장소 연결',
    summary: '장소 고르기 — 관광정보에 연결',
    description: [
      '일정 항목을 사용자가 고른 관광정보 장소(`contentid`)에 연결한다(`CONFIRMED`). 연결된 항목만 운영시간 · 휴무일 검수를 받는다.',
      '',
      '- 고르는 순간 공사 공통정보를 1번 불러 유형 · 분류 · 좌표를 항목에 저장한다. **저장하는 것은 번호 · 코드 · 좌표뿐이다** — 이름 · 주소는 이 응답에만 싣는다.',
      '- `matchedBy` 는 누가 골랐는지다. 결과가 1곳이라 화면이 바로 고르면 `AUTO`, 목록에서 고르면 `USER`, AI 제안 카드에서 고르면 `AGENT` 이고, 빠지거나 다른 값이면 `USER` 다.',
      '- 이미 고른 항목도 다른 장소로 다시 고를 수 있다.',
      '- `sourceBadge` 는 공사 원문 표시다. 이용 조건이 대부분 변경금지(Type3)라 늘 「변경금지」를 함께 적는다.',
      '- `itemId` 가 숫자가 아니면 400 이다.',
    ].join('\n'),
    screen: '기획 › 장소 칸 › 고르기 · 기획 › AI로 한 번에 찾기 › 이곳으로 선택 · 찾은 N곳 모두 선택',
    calls: '공사 detailCommon2 1콜 · 캐시 없음 · 예산 게이트를 거치지 않는다',
    spec: 'FR-IN-021 · FR-IN-027 ~ 029 · FR-AG-012 · API 설계 4-4 · 5-3',
    params: {
      itemId: { description: '일정 항목 번호', type: 'integer' },
    },
    body: {
      example: { contentid: '129784', matchedBy: 'USER' },
      required: ['contentid'],
      fields: {
        contentid: '고른 장소의 관광정보 번호 — `GET /contents/search` 후보의 `contentid`',
        matchedBy: '`AUTO` · `USER` · `AGENT`. 없으면 `USER`',
      },
    },
    responses: {
      200: {
        description: '연결됨. `content` 의 이름 · 주소는 방금 공사에서 받은 값이다',
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
          sourceBadge: { type: 'KTO_RAW', note: '변경금지' },
        },
      },
    },
    errors: [
      { status: 400, reasonCode: 'NOT_FOUND', when: '본문의 `contentid` 가 비어 있음', message: 'contentid 가 필요합니다.', unit: 'ITEM' },
      {
        status: 400,
        reasonCode: 'CONTENT_NOT_FOUND',
        when: '공사 공통정보에서 유형(`contenttypeid`)을 읽지 못함',
        message: '선택한 관광지 정보를 가져오지 못했습니다.',
        unit: 'ITEM',
      },
      { status: 404, reasonCode: 'NOT_FOUND', when: '없는 항목이거나 다른 계정의 항목', message: '항목을 찾을 수 없습니다 (#338).', unit: 'ITEM' },
      {
        status: 503,
        reasonCode: 'CONTENT_NOT_FOUND',
        when: '공사에 없는 `contentid` — 공통정보가 0건',
        message: EXTERNAL_UNAVAILABLE_MESSAGE,
      },
      {
        status: 503,
        reasonCode: 'KTO_FETCH_FAILED',
        when: '공사 공통정보 호출이 재시도 뒤에도 실패함',
        message: EXTERNAL_UNAVAILABLE_MESSAGE,
      },
    ],
  },
  {
    route: 'POST /api/v1/items/{itemId}/exclude',
    tag: '4. 장소 연결',
    summary: '직접 정한 곳으로 두기',
    description: [
      '관광정보에서 찾을 수 없는 곳을 **지우지 않고** 「직접 정한 곳」(`EXCLUDED`)으로 둔다. 일정표에는 그대로 남고 모든 검수 규칙의 판정에서만 빠진다.',
      '',
      '- 붙어 있던 관광정보 번호 · 유형 · 분류 · 좌표를 지운다. 사용자가 적은 장소 이름은 그대로다.',
      '- 공사를 부르지 않는다. 나중에 관광정보 장소로 바꾸려면 `POST /items/{itemId}/match` 를 부른다.',
      '- `itemId` 가 숫자가 아니면 400 이다.',
    ].join('\n'),
    screen: '기획 › 장소 칸 › 찾는 곳이 없나요? 직접 정한 곳으로 두기',
    calls: '없음 — DB 만 바꾼다',
    spec: 'FR-IN-024 · FR-IN-025 · FR-AG-012 · API 설계 4-4',
    params: {
      itemId: { description: '일정 항목 번호', type: 'integer' },
    },
    responses: {
      200: { description: '직접 정한 곳으로 바뀜', example: { itemId: 352, matchStatus: 'EXCLUDED' } },
    },
    errors: [
      { status: 404, reasonCode: 'NOT_FOUND', when: '없는 항목이거나 다른 계정의 항목', message: '항목을 찾을 수 없습니다 (#352).', unit: 'ITEM' },
    ],
  },
  {
    route: 'POST /api/v1/products/{productId}/place-suggestions',
    tag: '4. 장소 연결',
    summary: 'AI 장소 후보 제안',
    description: [
      '아직 고르지 않은 줄(`PENDING`)의 문구에서 AI 가 장소 이름을 뽑아 상품 지역 안에서 찾고, 줄마다 한 곳과 고른 이유 한 줄을 제안한다. ' +
        '**제안만 하고 일정은 바꾸지 않는다** — 사람이 카드의 「이곳으로 선택」을 눌러야 `POST /items/{itemId}/match`(`matchedBy: AGENT`)로 연결된다.',
      '',
      '- 줄마다 `FOUND`(찾은 곳 · 다른 후보 최대 3곳) · `NOT_FOUND` · `NO_NAME` 중 하나다. 「점심」 · 「숙소 체크인」처럼 일반 낱말뿐인 줄은 AI 도 공사도 부르지 않고 서버가 `NO_NAME` 으로 둔다.',
      '- 검색 지역은 AI 가 아니라 서버가 상품의 시도 · 시군구로 붙인다. 이름 · 주소 · 분류는 도구가 받은 공사 값만 싣고, 도구 결과에 없던 `contentId` 를 고른 줄은 버린다.',
      '- `alternatives[].distanceM` 은 같은 날 앞(없으면 뒤)의 고른 장소에서 잰 직선거리(m)이고 이동시간이 아니다. 잴 기준이 없으면 `null` 이다.',
      '- 실행한 뒤의 AI 실패 · 30초 초과 · 도중 예산 소진은 거절하지 않는다. 끝난 줄만 싣고 못 끝낸 줄은 `incomplete.itemIds` 에 담는다. AI 가 설정되지 않았을 때도 같다.',
      '- 제안 · 이유 · 도구 결과는 저장하지 않고 로그에도 남기지 않는다.',
      '- `productId` 가 양의 정수가 아니거나 `itemIds` 가 항목 번호 목록이 아니면 400 이다.',
    ].join('\n'),
    screen: '기획 › AI로 한 번에 찾기',
    calls:
      '공사 searchKeyword2(한 번에 8곳) · detailCommon2 — 도구 호출은 찾을 줄 수 × 2 까지 · 생성형 AI 1회 실행(도구를 주고받는 여러 턴 · 30초 상한) · ' +
      '공사 호출마다 검수와 같은 예산 게이트',
    spec: 'FR-AG-001 ~ 005 · FR-AG-010 ~ 012 · EX-AG-001 ~ 004 · UI-S2-044 · API 설계 4-11',
    params: {
      productId: { description: '상품 번호', type: 'integer', example: 38 },
    },
    body: {
      example: { itemIds: [352, 353, 354] },
      fields: {
        itemIds: '찾을 줄의 항목 번호. 빼면 고르지 않은 줄 전부. 고르지 않은 줄이 아닌 번호는 무시한다',
      },
    },
    responses: {
      200: {
        description: '줄마다 제안. 못 끝낸 줄이 있으면 `incomplete` 에 담긴다(다 끝났으면 `null`)',
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
      { status: 429, reasonCode: 'BUDGET_EXHAUSTED', when: '국문 관광정보의 오늘 호출 예산을 다 씀 — 실행 전에 거절', message: BUDGET_MESSAGE },
      {
        status: 429,
        reasonCode: 'RATE_LIMIT_EXCEEDED',
        when: '같은 계정에서 이 AI 가 이미 도는 중 — `Retry-After` 없음',
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
    route: 'GET /api/v1/contents/{contentId}',
    tag: '4. 장소 연결',
    summary: '장소 원문 1건 실시간 조회',
    description: [
      '관광정보 장소 1곳의 공식 명칭 · 홈페이지 · 문의처와 판정에 쓰는 원문(운영시간 · 휴무일 등)을 공사에서 지금 받아 돌려준다. ' +
        '**DB 에서 읽지 않고 저장하지도 않는다** — 화면이 원문을 보여 줘야 하는 그 순간에 그 1건만 부른다.',
      '',
      '- `ktoRaw` 는 검수가 판정에 쓰는 소개정보 필드의 원문이다(키는 공사 필드 이름). 한 글자도 고치지 않는다.',
      '- 좌표 · 분류 · 유형도 함께 준다. 새 상품 기획에서 후보를 고르면 이 값을 일정 저장에 싣는다.',
      '- `contentTypeId` 를 주면 공통정보 · 소개정보를 동시에 부르고, 없으면 공통정보로 유형을 읽은 뒤 소개정보를 부른다. 콜 수는 같다.',
      '- `with=accessible,pet` 을 주면 요청한 축마다 무장애 · 반려동물 동반 상세를 붙인다. 못 받은 축은 `null` 이고 나머지는 그대로다. `with` 에 다른 값이 있으면 400 이다.',
      '- 공사 조회가 실패해도 200 이다. 소개정보를 못 받으면 `unavailableReason` 에 사유코드가 담긴다 — 없는 번호면 `CONTENT_NOT_FOUND`.',
    ].join('\n'),
    screen: '검수 결과 › 판단 근거 보기 · 직접 확인할 곳 › 판단 근거 보기 · 새 상품 기획 › 장소 후보 고르기',
    calls:
      '공사 detailCommon2 · detailIntro2 1콜씩(캐시 없음 · 예산 게이트를 거치지 않는다). `with` 의 축마다 무장애 detailWithTour2 · 반려동물 detailPetTour2 1콜 — ' +
      '10분 메모리 캐시 · 서비스마다 예산 게이트, 막히면 그 축만 `null`',
    spec: 'DR-PR-004 · FR-IN-030 · FR-AU-061 · FR-AU-081 · FR-PL-012 · API 설계 4-4 · 5-12',
    params: {
      contentId: { description: '관광정보 콘텐츠 번호', example: '129784' },
      contentTypeId: {
        description: '공사 유형 코드 — 12 관광지 · 14 문화시설 · 15 행사 · 28 레포츠 · 32 숙박 · 38 쇼핑 · 39 음식점. 모르거나 다른 값이면 공통정보로 알아낸다',
        type: 'integer',
        example: 14,
      },
      with: { description: '`accessible` · `pet` 을 쉼표로 잇는다. 요청한 축의 상세를 함께 붙인다', example: 'accessible,pet' },
    },
    responses: {
      200: {
        description: '원문 1건. `with` 로 요청한 축만 붙는다',
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
