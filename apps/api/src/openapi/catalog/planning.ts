import { EXTERNAL_UNAVAILABLE_MESSAGE } from '@tourlint/shared';
import type { Endpoint, ErrorDoc, ParamDoc } from '../types';

/** 5. 기획 · 장소 담기 */

const BUDGET_EXHAUSTED: ErrorDoc = {
  status: 429,
  reasonCode: 'BUDGET_EXHAUSTED',
  when: '국문 관광정보의 오늘 호출 예산을 다 씀',
  message:
    '오늘 쓸 수 있는 관광정보 조회를 모두 썼습니다. 내일 0시부터 다시 볼 수 있고, 일정 입력과 저장은 지금도 할 수 있습니다.',
};

const KTO_FAILED: ErrorDoc = {
  status: 503,
  reasonCode: 'KTO_FETCH_FAILED',
  when: '공사 목록 호출이 재시도 뒤에도 실패함 — 인증 · 한도 문제면 `KTO_AUTH_ERROR` · `KTO_QUOTA_EXCEEDED`',
  message: EXTERNAL_UNAVAILABLE_MESSAGE,
};

const REGN_CD: ParamDoc = { description: '시도 코드(법정동) 2자리. 세종은 `36110`', required: true, example: '51' };
const SIGNGU_CD: ParamDoc = { description: '시군구 코드 3자리. 세종처럼 시군구가 없으면 비운다', example: '150' };

export const PLANNING: readonly Endpoint[] = [
  {
    route: 'GET /api/v1/plan/briefing',
    tag: '5. 기획 · 장소 담기',
    summary: '지역 브리핑 · 종류 칩',
    description: [
      '장소 담기를 열 때 그 지역의 종류 칩 첫째 줄과 등록 수를 돌려준다. 기본 중분류 4개(랜드마크관광 · 자연경관(하천‧해양) · 전시시설 · 공예체험) 칩 뒤에 ' +
        '축제 · 공연(`EVENT`) · 걷기 길(`WALK`) 칩이 붙는다.',
      '',
      '- 칩 숫자는 `GET /plan/places` 와 같은 조건으로 센 공사 등록 수라, 필터 없이 연 목록의 `totalCount` 와 같다. 「기대」 · 「없음」 같은 판정 표시는 두지 않는다.',
      '- `events` 는 여행 기간 앞뒤 3일과 기간이 겹치는 행사 수, `walks` 는 걷기 길 수, `accessible` · `pet` 은 그 시군구의 무장애 · 반려동물 동반 등록 수다. ' +
        '못 받았으면 **0 이 아니라 `null`** 이다(무장애 · 반려동물은 시군구가 없을 때도 `null`).',
      '- 식당 · 카페 · 숙소(둘째 줄)는 넣을 위치가 정해져야 셀 수 있어 여기서 세지 않는다.',
      '- `extraLcls2` 로 기본에 없는 중분류 칩을 더한다. 음식 · 숙박 · 추천코스와 모르는 코드는 무시한다.',
      '- `budget` 은 국문 관광정보의 오늘 예산 상태다 — `OK` · `WARN`(80% 이상) · `PAUSED`(다 씀).',
      '- `regnCd` · `signguCd` · `startDate` 형식이 틀리거나 `nights` 가 0 ~ 30 밖이면 400 이다.',
    ].join('\n'),
    screen: '기획 › 장소 담기 · 새 상품 기획 › 장소 담기 · 검수 결과 › 장소 담기 (열 때)',
    calls:
      '처음 열 때 공사 최대 9콜(기본 칩 기준) — 지역 이름 ldongCode2 1 · 중분류 칩마다 areaBasedList2 1(`numOfRows=1` 의 전체 건수) · searchFestival2 1 · ' +
      '두루누비 courseList 1 · 무장애 · 반려동물 지역 목록 각 1. 모두 10분 메모리 캐시 · 국문은 검수와 같은 예산 게이트, 새 서비스는 서비스마다 따로 센다',
    spec: 'FR-PL-010 · FR-PL-017 · FR-PL-018 · FR-PL-022 · EX-PL-004 · API 설계 4-10',
    params: {
      regnCd: REGN_CD,
      signguCd: SIGNGU_CD,
      startDate: { description: '출발일 `YYYY-MM-DD`. 행사 수를 셀 기간의 기준', required: true, example: '2026-11-17' },
      nights: { description: '박 수 0 ~ 30. 기본 0', type: 'integer', example: 2 },
      extraLcls2: { description: '더할 중분류 코드. 쉼표로 여럿' },
    },
    responses: {
      200: {
        description: '종류 칩과 지역 요약',
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
    tag: '5. 기획 · 장소 담기',
    summary: '장소 담기 목록',
    description: [
      '장소 담기에서 칩을 누르면 그 종류의 장소 카드를 한 쪽 20곳씩 돌려준다. `scope=SIGNGU`(기본)는 시군구 전체의 중분류 `lcls2` 하나, ' +
        '`scope=NEAR3KM` 은 넣을 위치 앞 장소(`anchor`)에서 반경 3km 안의 식당 · 카페 · 숙소(`nearKind`)다.',
      '',
      '- `sort=near` 에 `anchor` 를 주면 그 좌표에서 가까운 순이다(반경 20km 밖은 거리 없이 뒤로 · `scope.kind` 는 `NEAR`). `sort=together` 는 「함께 많이 가는 순」으로, ' +
        '`anchorContentId` 장소 기준 공사 연관 관광지 순위(관광지만)가 목록의 한 곳과만 이름이 맞을 때 `togetherRank` 를 붙인다. 기준 장소가 없으면 순서를 바꾸지 않고 `notice` 로 알린다.',
      '- 근처 3km 는 늘 가까운 순이고 순위가 없다. 식당은 주점 · 카페를 빼고, 카페는 카페/찻집만, 숙소는 숙박 전체다. ' +
        '`anchor` 가 없으면 공사를 부르지 않고 `disabled: "ANCHOR_REQUIRED"` 와 빈 목록을 준다.',
      '- 필터 `wheelchair` · `pet` · `indoor` 는 `1` 이면 켠다 — 무장애 · 반려동물 목록에 있는 곳, 표준 실내 · 야외 표에서 실내인 곳만 남긴다. ' +
        '그 목록을 못 받으면 값이 **「아니다」가 아니라 `null`** 이고 `notice` 로 알린다.',
      '- `totalCount` 는 필터를 건 뒤의 전체 곳 수이고 `page` 는 1부터다. 제목 · 주소 · 사진 URL 은 응답으로만 흐르고 저장하지 않는다.',
      '- 시군구 목록인데 `lcls2` 가 없거나, `scope` · `nearKind` · `sort` · `anchor` · `page` 형식이 틀리면 400 이다.',
    ].join('\n'),
    screen: '기획 › 장소 담기 › 종류 칩 · 식당 · 카페 · 숙소 · 정렬 · 필터 (새 상품 기획 · 검수 결과의 장소 담기도 같다)',
    calls:
      '시군구 — areaBasedList2 100행씩 끝까지(보통 1콜) · 지역 이름 ldongCode2 1, `near` 면 locationBasedList2(반경 20km) 1, `together` 면 연관 관광지 searchKeyword1 1' +
      '(기준 장소가 목록에 없으면 detailCommon2 1 더). 근처 3km — locationBasedList2(반경 3km) 1000행씩 끝까지. 둘 다 무장애 · 반려동물 지역 목록 각 1. ' +
      '연관 관광지 · 기준 장소 조회 말고는 10분 메모리 캐시 · 국문은 검수와 같은 예산 게이트(쪽마다 다시 확인), 새 서비스는 서비스마다 따로 센다',
    spec: 'FR-PL-010 · FR-PL-011 · FR-PL-017 · EI-KT-022 ~ 024 · EX-PL-004 · EX-PL-008 · API 설계 4-10',
    params: {
      regnCd: REGN_CD,
      signguCd: SIGNGU_CD,
      scope: { description: '`SIGNGU`(기본) 시군구 전체 · `NEAR3KM` 넣을 위치 근처 3km', enum: ['SIGNGU', 'NEAR3KM'] },
      lcls2: { description: '중분류 코드. `SIGNGU` 에서 필수', example: 'VE07' },
      nearKind: { description: '`NEAR3KM` 에서 필수 — 식당 · 카페 · 숙소', enum: ['MEAL', 'CAFE', 'STAY'] },
      sort: { description: '`near` 가까운 순 · `together` 함께 많이 가는 순. `SIGNGU` 에서만 쓴다', enum: ['near', 'together'] },
      anchor: { description: '기준 좌표 `경도,위도`(예: `128.8961,37.7952`). 넣을 위치 앞의 고른 장소' },
      anchorContentId: { description: '기준 장소의 콘텐츠 번호. `together` 가 이 장소의 이름으로 찾는다' },
      wheelchair: { description: '`1` 이면 휠체어 가능한 곳만' },
      pet: { description: '`1` 이면 반려동물 동반 가능한 곳만' },
      indoor: { description: '`1` 이면 실내인 곳만' },
      page: { description: '쪽 번호. 1부터 · 한 쪽 20곳', type: 'integer', example: 1 },
    },
    responses: {
      200: {
        description: '장소 카드 한 쪽',
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
    errors: [BUDGET_EXHAUSTED, { ...KTO_FAILED, when: '공사 목록이나 그다음 쪽을 받지 못함 — 일부만 전체인 것처럼 주지 않는다' }],
  },
  {
    route: 'GET /api/v1/plan/place-detail',
    tag: '5. 기획 · 장소 담기',
    summary: '장소 카드 자세히',
    description: [
      '장소 카드의 「자세히」를 펼치면 그 장소의 이용시간 · 쉬는 날 · 요금 · 주차와 행사 기간을 공사 소개정보에서 **펼칠 때마다** 받아 돌려준다. ' +
        '상품 · 항목이 아니라 `contentId` 로 부르므로 저장 전 카드에서도 쓴다.',
      '',
      '- 값은 공사 원문 그대로이고 응답으로만 흐른다. 유형마다 읽는 필드가 다르다 — 숙박의 `hours` 는 입실 · 퇴실이고, 요금은 문화시설 · 행사 · 레포츠에만 있다.',
      '- 소개정보를 못 받았거나 원문에 없는 칸은 `null` 이다. 오류로 막지 않는다.',
      '- 쉬는 날이 여행 날짜와 겹쳐도 표시를 붙이지 않는다. 그날 쉬는지는 검수가 판정한다.',
      '- 무장애 · 반려동물 여부는 목록 응답에 이미 있어 여기서 내지 않는다.',
      '- `contentId` 가 없거나 `contentTypeId` 가 12 · 14 · 15 · 28 · 32 · 38 · 39 가 아니면 400 이다.',
    ].join('\n'),
    screen: '기획 › 장소 담기 › 자세히 (새 상품 기획 · 검수 결과의 장소 담기도 같다)',
    calls: '공사 detailIntro2 1콜 · 캐시 없음 · 검수와 같은 예산 게이트',
    spec: 'FR-PL-012 · FR-PL-018 · UI-S2-040 · API 설계 4-10',
    params: {
      contentId: { description: '관광정보 콘텐츠 번호', required: true, example: '129784' },
      contentTypeId: {
        description: '공사 유형 코드 — 12 관광지 · 14 문화시설 · 15 행사 · 28 레포츠 · 32 숙박 · 38 쇼핑 · 39 음식점',
        required: true,
        type: 'integer',
        example: 14,
      },
    },
    responses: {
      200: {
        description: '카드 자세히 값. 못 받은 칸은 `null`',
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
    tag: '5. 기획 · 장소 담기',
    summary: '행사 · 공연 목록',
    description: [
      '여행 기간 앞뒤 3일에 걸치는 그 지역의 축제 · 공연을 행사 기간과 함께 돌려준다. 행사마다 여행 날짜와의 관계(`relation`)와 옮길 출발일 제안을 붙인다.',
      '',
      '- `relation` 은 `IN`(하루라도 겹침) · `BEFORE`(여행 전에 끝남) · `AFTER`(여행이 끝난 뒤 시작)다. **참고 표시일 뿐 판정이 아니다** — 방문일이 행사 기간 안인지는 검수가 본다.',
      '- 겹치지 않는 행사에만 `suggestedStartDate`(그 행사의 시작일)를 준다. 겹치면 `null` 이다.',
      '- 창(`window`)이 시작되기 전에 끝난 행사와 기간을 모르는 행사는 뺀다. 창보다 늦게 시작하는 행사는 공사가 준 만큼 싣는다.',
      '- 행사명 · 사진 URL 은 응답으로만 흐르고 저장하지 않는다.',
      '- 파라미터 형식이 틀리면 400 이다(`GET /plan/briefing` 과 같다).',
    ].join('\n'),
    screen: '기획 › 장소 담기 › 행사 · 공연',
    calls: '공사 searchFestival2 1콜(최대 100건) · 10분 메모리 캐시 · 검수와 같은 예산 게이트',
    spec: 'FR-PL-014 · FR-PL-018 · API 설계 4-10',
    params: {
      regnCd: REGN_CD,
      signguCd: SIGNGU_CD,
      startDate: { description: '출발일 `YYYY-MM-DD`', required: true, example: '2026-10-15' },
      nights: { description: '박 수 0 ~ 30. 기본 0', type: 'integer', example: 1 },
    },
    responses: {
      200: {
        description: '행사 목록. `window` 는 여행 기간 앞뒤 3일',
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
    tag: '5. 기획 · 장소 담기',
    summary: '걷기 길 목록',
    description: [
      '두루누비 걷기 길 중 상품 지역의 코스를 길이 · 걸리는 시간 · 난이도와 함께 돌려준다. 일정에 넣으면 **직접 정한 곳**(`EXCLUDED`)으로 들어간다 — ' +
        '걷기 길에는 관광정보 `contentid` 가 없어 운영시간 검수 대상이 아니다.',
      '',
      '- 두루누비에는 지역 조건이 없어 전국 코스 목록을 한 번 받고, 코스의 `sigun`(「강원 강릉시」 꼴)에 법정동 코드표의 지역 이름이 들어 있는 코스만 남긴다. ' +
        '시군구를 줬는데 그 이름을 모르면 넓혀 찾지 않고 빈 목록이다.',
      '- 코스에 좌표가 없어 근처 3km 의 기준이 되지 못한다.',
      '- 넣을 때는 `POST /products/{productId}/items` 에 `walkId` 만 보내고 코스 이름은 저장하지 않는다. 이름은 보일 때 이 목록에서 찾는다.',
      '- 두루누비를 부르지 못하면(예산 · 장애) 빈 목록이다. 이때 `GET /plan/briefing` 의 `walks` 는 `null` 이다.',
      '- `regnCd` · `signguCd` 형식이 틀리면 400 이다.',
    ].join('\n'),
    screen: '기획 › 장소 담기 › 걷기 길',
    calls: '두루누비 courseList 1콜(전국 · 10분 메모리 캐시 · 두루누비 예산을 따로 센다) · 지역 이름 ldongCode2 1콜(10분 캐시)',
    spec: 'FR-PL-015 · EI-KT-025 · EX-PL-011 · API 설계 4-10',
    params: {
      regnCd: REGN_CD,
      signguCd: SIGNGU_CD,
    },
    responses: {
      200: {
        description: '걷기 길 목록',
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
    tag: '5. 기획 · 장소 담기',
    summary: '고른 장소 정보 한 줄',
    description: [
      '기획 화면에서 고른 장소(`CONFIRMED`) 아래 붙는 정보 한 줄 — 이용시간 · 쉬는 날 · 요금 · 주차 · 행사 기간과 앞 장소에서 차로 걸리는 시간 — 을 돌려준다. ' +
        '**규칙 판정을 하지 않고 아무것도 저장하지 않는다** — 여러 번 불러도 상품은 그대로다.',
      '',
      '- `itemIds` 를 주면 그 항목만, 빼면 고른 항목 전부다. 아직 고르지 않은 줄과 직접 정한 곳은 넣지 않는다.',
      '- 값은 공사 소개정보 원문을 유형별 필드에서 그대로 옮긴다. 못 받은 값은 `null` 이다.',
      '- `travelFromPrevMinutes` 는 같은 날 바로 앞 줄도 고른 곳이고 양쪽 좌표가 있을 때만 카카오모빌리티 자동차 길찾기로 잰다. ' +
        '대중교통 상품이거나 길찾기가 실패하면 `null` 이고 직선거리로 짐작하지 않는다.',
      '- 장소 이름을 저장하지 않은 항목(장소 담기 · 수정안으로 넣은 곳)은 공사에서 이름을 찾아 응답에만 싣는다.',
      '- `matchedBy` 는 고른 방식(`AUTO` · `USER` · `AGENT`), `origin` 은 항목이 들어온 경로(`MANUAL` · `UPLOAD` · `TEXT` · `PICKER` · `SIGNAL` · `PATCH`)다.',
      '- `productId` 가 양의 정수가 아니거나 `itemIds` 가 항목 번호 목록이 아니면 400 이다.',
    ].join('\n'),
    screen: '기획 › 고른 장소 아래 정보 한 줄 (화면을 열 때 · 장소를 고른 뒤)',
    calls:
      '항목마다 공사 detailIntro2 1콜(10분 메모리 캐시) · 이름이 빈 항목은 detailCommon2 1콜(10분 캐시) · ' +
      '앞 구간마다 카카오모빌리티 길찾기 1 – 2콜(미래 운행 조회가 안 되면 일반 조회) · 공사 호출 전에 검수와 같은 예산 게이트',
    spec: 'FR-PL-005 · FR-PL-018 · EX-PL-006 · API 설계 4-10',
    params: {
      productId: { description: '상품 번호', type: 'integer', example: 38 },
    },
    body: {
      example: { itemIds: [338] },
      fields: { itemIds: '볼 항목 번호. 빼면 고른 항목 전부' },
    },
    responses: {
      200: {
        description: '고른 항목마다 한 줄',
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
