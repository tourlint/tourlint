import type { Endpoint, ErrorDoc, ParamDoc } from '../types';
import { OWN_PRODUCT, productNotFound } from './products';

/*
 * 3. 일정 입력 · 편집.
 *
 * 쓰기 예시는 `products.ts` 의 새 상품(41)을 잇는다 — 1일차에 경포대(351 · 10:00 ~ 11:30)와
 * 가람집옹심이(352 · 12:00 ~ 13:00)를 넣고 만든 상품이다. 경로 번호에 예시를 넣지 않는 까닭도 거기 적었다.
 */

/** 쓰기 API 의 항목 번호. 예시를 넣지 않는다 */
const OWN_ITEM: ParamDoc = {
  description: '일정 항목 번호(`itemId`). 직접 만든 상품의 항목만 — 테스트 계정은 여럿이 함께 쓴다',
  type: 'integer',
};

/** 남의 항목도 없는 항목과 똑같이 404 다 (item → product → account 로 스코프) */
function itemNotFound(itemId: number): ErrorDoc {
  return {
    status: 404,
    reasonCode: 'NOT_FOUND',
    when: '없는 항목이거나 다른 계정의 항목',
    message: `일정 항목을 찾을 수 없습니다 (#${String(itemId)}).`,
  };
}

const ITEM_TYPES = 'SIGHT(관광) · MEAL(식사) · LODGING(숙박) · REST(휴식) · MOVE(이동) · FREE(자유)';

export const ITINERARY: readonly Endpoint[] = [
  {
    route: 'GET /api/v1/uploads/template',
    tag: '3. 일정 입력 · 편집',
    summary: '지정 양식 내려받기',
    description: [
      '일정 업로드에 쓰는 지정 양식(.xlsx)을 내려준다. 5행이 헤더(일차 · 시작시간 · 종료시간 · 장소명 · 유형, A ~ E 열)이고 그 아래에 강릉 2박 3일 예시 18줄이 들어 있다.',
      '',
      '- 받은 파일을 그대로 `POST /api/v1/uploads/schedule` 에 올리면 2박 3일 · 18개 항목으로 읽힌다.',
    ].join('\n'),
    screen: '새 상품 기획 › 엑셀·CSV 업로드 › 지정 양식 내려받기',
    calls: '없음 — 서버에 둔 양식 파일을 내려준다',
    spec: 'FR-IN-002 · API 설계 4-3',
    responses: {
      200: {
        description: '`tourlint_schedule_template.xlsx` 첨부 파일',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    },
  },
  {
    route: 'POST /api/v1/uploads/schedule',
    tag: '3. 일정 입력 · 편집',
    summary: '엑셀 · CSV 일정 불러오기',
    description: [
      '지정 양식 엑셀(.xlsx)이나 CSV 를 읽어 일정 표로 바꿔 돌려준다. **저장하지 않는다** — 화면이 결과를 편집기에 채우고, ' +
        '저장은 `POST /api/v1/products` 의 `days` 로 한다. 파일은 메모리에서 읽고 버린다.',
      '',
      '- 헤더 행(일차 · 시작시간 · 종료시간 · 장소명 · 유형)을 찾아 그 아래 행을 A ~ E 열 순서로 읽는다. 엑셀은 첫 시트만, CSV 는 UTF-8 로 읽는다.',
      '- 형식이 틀린 행은 빼고 행 번호와 사유를 `errors` 에 남긴다. 나머지 행은 `items` 로 살린다. `nights` 는 가장 큰 일차에서 1을 뺀 값이다.',
      '- 파일을 통째로 거부하면 `items` 가 비고 `rejected` 에 사유가 온다(HTTP 는 201 그대로) — `UPLOAD_LIMIT_EXCEEDED`(5MB · 500행 · 유효 항목 45개 초과), ' +
        '`TEMPLATE_MISMATCH`(헤더나 필수 컬럼이 없음), `DAY_COUNT_MISMATCH`(4일차 이상).',
      '- 파일이 없거나 .xlsx · .csv 가 아니면 400, 20MB 를 넘으면 읽지 않고 413 이다.',
    ].join('\n'),
    screen: '새 상품 기획 › 엑셀·CSV 업로드 › 파일 선택',
    calls: '없음 — 받은 파일만 읽는다',
    spec: 'FR-IN-002 · 015 · API 설계 4-3',
    body: {
      contentType: 'multipart/form-data',
      example: { file: '(xlsx 또는 csv 파일)' },
      required: ['file'],
      files: ['file'],
      fields: { file: '지정 양식 .xlsx 또는 CSV. 필드 이름은 `file`' },
    },
    responses: {
      201: {
        description: '읽은 결과 — 저장하지 않았다. 예시는 4행 시작시간이 25:00 인 CSV 다',
        example: {
          nights: 1,
          items: [
            { day: 1, start: '10:00', end: '11:30', place: '오죽헌', itemType: 'SIGHT' },
            { day: 1, start: '12:00', end: null, place: '소나무집초당순두부', itemType: 'MEAL' },
            { day: 2, start: '09:30', end: '11:00', place: '경포대', itemType: 'SIGHT' },
          ],
          errors: [{ row: 4, reason: '시작시간 형식이 올바르지 않습니다(HH:MM): "25:00"' }],
        },
      },
    },
  },
  {
    route: 'POST /api/v1/uploads/schedule-text',
    tag: '3. 일정 입력 · 편집',
    summary: '자연어 일정을 표로 바꾸기',
    description: [
      '붙여넣은 일정 글을 생성형 AI 로 일정 표로 바꿔 돌려준다. 모양은 엑셀 · CSV 업로드와 같고 여기서도 **저장하지 않는다** — ' +
        '사람이 화면에서 확인 · 수정한 뒤 `POST /api/v1/products` 로 저장한다.',
      '',
      '- AI 에게는 적힌 것만 옮기라고 지시한다. 종료 시각이 없으면 null, 일차가 없으면 1일차로 두고, 유형은 관광 · 식사 · 숙박 · 휴식 · 이동 · 자유 중에서만 고르게 한다.',
      '- AI 가 낸 값도 업로드와 같은 규칙(1 ~ 3일차 · HH:MM · 유형 6종)으로 다시 거른다. 못 쓰는 항목은 몇 번째인지와 사유를 `errors` 에 남기고, 나머지는 일차 · 시각 순으로 세운다.',
      '- 통째로 거부하면 `items` 가 비고 `rejected` 에 사유가 온다(HTTP 는 201 그대로) — `UPLOAD_LIMIT_EXCEEDED`(4,000자 · 항목 45개 초과), ' +
        '`NL_STRUCTURE_FAILED`(빈 글 · AI 미설정 · 호출 실패 · 쓸 수 있는 항목 없음). 빈 상품은 만들지 않는다.',
      '- `text` 가 문자열이 아니면 400 이다.',
    ].join('\n'),
    screen: '새 상품 기획 › 자연어 붙여넣기 › 일정으로 바꾸기',
    calls:
      '생성형 AI 1콜 — 네트워크 · 시간 초과 · 429 · 5xx 로 실패하면 한 번 더 부른다. 붙여넣은 글만 보내고, ' +
      '호출 기록에는 시각 · 모델 · 결과만 남긴다(글과 답은 남기지 않는다)',
    spec: 'FR-IN-003 · 013 · API 설계 4-3',
    body: {
      example: { text: '1일차 / 10시 오죽헌 들렀다가 / 12시쯤 중앙시장에서 점심 / 2시 안목해변 / 저녁 6시 식사하고 8시 숙소' },
      required: ['text'],
      fields: { text: '일정을 적은 글. 앞뒤 공백을 뺀 4,000자까지' },
    },
    responses: {
      201: {
        description: '바꾼 결과 — 저장하지 않았다. 예시는 기능 요구사항 FR-IN-003 의 예문을 넣은 결과다',
        example: {
          nights: 0,
          items: [
            { day: 1, start: '10:00', end: null, place: '오죽헌', itemType: 'SIGHT' },
            { day: 1, start: '12:00', end: null, place: '중앙시장', itemType: 'MEAL' },
            { day: 1, start: '14:00', end: null, place: '안목해변', itemType: 'SIGHT' },
            { day: 1, start: '18:00', end: null, place: '식사', itemType: 'MEAL' },
            { day: 1, start: '20:00', end: null, place: '숙소', itemType: 'LODGING' },
          ],
          errors: [],
        },
      },
    },
  },
  {
    route: 'GET /api/v1/products/{productId}/items',
    tag: '3. 일정 입력 · 편집',
    summary: '일정 항목 목록',
    description: [
      '상품의 일정 항목을 일차 · 순번 순의 한 줄 목록으로 돌려준다. 저장된 값 그대로다.',
      '',
      '- 이름을 찾아 채우지 않는다. 장소 담기 · 걷기 길로 넣은 항목은 `place` 가 빈 문자열이다 — ' +
        '이름까지 채운 일정은 `GET /api/v1/products/{productId}` 의 `days` 에 있고, 화면은 그쪽을 쓴다.',
      '- `walkId` 는 걷기 길로 넣은 항목의 코스 번호다.',
      '- 다른 계정의 상품이면 404 다.',
    ].join('\n'),
    calls: '없음 — DB 만 읽는다',
    spec: 'FR-IN-009 · API 설계 4-3',
    params: { productId: { description: '상품 번호 — 목록의 `productId`', example: 38, type: 'integer' } },
    responses: {
      200: {
        description: '일정 항목. 예시는 운영 상품 38 의 응답을 줄였다',
        example: {
          totalCount: 16,
          items: [
            {
              itemId: 337,
              dayNo: 1,
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
            },
            '…외 15개',
          ],
        },
      },
    },
    errors: [productNotFound(38)],
  },
  {
    route: 'POST /api/v1/products/{productId}/items',
    tag: '3. 일정 입력 · 편집',
    summary: '일정 항목 추가',
    description: [
      '일정에 항목 하나를 넣는다. 본문에 무엇을 담느냐에 따라 세 가지로 들어간다.',
      '',
      '- 장소 담기(`content`, 예시) — 고른 장소를 연결된 장소(`CONFIRMED`)로 `afterItemId` 다음에 끼우고 뒤 항목을 한 칸씩 민다. ' +
        '시작은 앞 항목 종료 + 차 이동시간, 종료는 시작 + 분류별 표준 체류시간이다(숙박은 비움). ' +
        '이동시간을 잴 수 없으면(좌표 없음 · 대중교통 · 조회 실패) 앞 항목 종료에 바로 붙이고, 빈 날이면 09:00 에 시작한다.',
      '- 걷기 길 — `{"dayNo": 2, "excluded": {"walkId": "T_CRS_MNG0000004219"}}` 는 검수 제외(`EXCLUDED`)로 그 날 끝에 붙인다. ' +
        '그 날 마지막 항목의 종료(빈 날이면 09:00)부터 90분이고, 코스 이름은 받지도 저장하지도 않는다.',
      '- 직접 입력 — `{"dayNo": 1, "startTime": "12:00", "endTime": "13:00", "placeLabel": "가람집옹심이", "itemType": "MEAL"}` 은 ' +
        '고를 곳(`PENDING`)으로 그 날 끝에 붙인다. `endTime` 은 비워도 된다.',
      '- **있던 항목의 시각은 바꾸지 않는다.** 응답은 넣은 항목이다. 장소 담기 · 걷기 길은 이름을 저장하지 않아 `place` 가 비어 있고, ' +
        '좌표 · `walkId` 는 응답에서 null 이다 — 화면은 상품 상세를 다시 읽는다.',
      '- `dayNo` 가 1 ~ 박수+1 밖이거나 형식이 틀리면 400, 다른 계정의 상품이면 404 다.',
    ].join('\n'),
    screen:
      '기획 화면 · 검수 결과 › 장소 담기 › 일정에 넣기, 기획 화면 › 장소 담기 › 걷기 길 › 일정에 넣기, 일정 편집 › 저장(새로 적은 줄)',
    calls: '장소 담기로 넣을 때만 카카오모빌리티 길찾기 1콜(앞 항목과 새 장소에 좌표가 있고 대중교통이 아닐 때). 그 밖에는 DB 에만 쓴다',
    spec: 'FR-IN-014 · FR-PL-013 · PM-NG-011 · API 설계 4-3',
    params: { productId: OWN_PRODUCT },
    body: {
      example: {
        dayNo: 1,
        afterItemId: 351,
        itemType: 'SIGHT',
        origin: 'PICKER',
        content: {
          contentId: '129784',
          contentTypeId: 14,
          lcls1: 'VE',
          lcls2: 'VE07',
          mapx: 128.87966210169768,
          mapy: 37.779138874844655,
        },
      },
      required: ['dayNo'],
      fields: {
        dayNo: '넣을 일차. 1 ~ 박수+1',
        afterItemId: '이 항목 다음에 끼운다. 없거나 그 날 항목이 아니면 그 날 끝에 붙인다',
        itemType: `${ITEM_TYPES}. 장소 담기 · 직접 입력은 필수, 걷기 길은 없으면 SIGHT`,
        origin: '보내지 않아도 된다 — 장소 담기 · 걷기 길은 서버가 PICKER 로 기록한다',
        content: '고른 장소 — `GET /api/v1/plan/places` 가 준 값 그대로. 제목 · 주소는 보내지 않는다',
        'content.contentId': '관광정보 콘텐츠 ID',
        'content.contentTypeId': '관광 타입 ID',
        'content.lcls1': '대분류 코드',
        'content.lcls2': '중분류 코드 — 표준 체류시간을 정한다(표에 없으면 90분)',
        'content.mapx': '경도 — 이동시간 계산에 쓴다',
        'content.mapy': '위도',
      },
    },
    responses: {
      201: {
        description: '넣은 항목. 예시는 경포대(10:00 ~ 11:30) 다음에 오죽헌(전시시설 · 표준 90분)을 넣은 것 — 차로 5분이라 11:35 에 시작한다',
        example: {
          itemId: 353,
          dayNo: 1,
          seq: 2,
          start: '11:35',
          end: '13:05',
          place: '',
          itemType: 'SIGHT',
          ktoContentId: '129784',
          matchStatus: 'CONFIRMED',
          mapx: null,
          mapy: null,
          walkId: null,
        },
      },
    },
    errors: [productNotFound(41)],
  },
  {
    route: 'PUT /api/v1/products/{productId}/items/order',
    tag: '3. 일정 입력 · 편집',
    summary: '일정 순서 · 일차 옮기기',
    description: [
      '상품의 모든 항목에 새 자리(일차 · 순번)를 한 번에 매긴다. 편집기에서 줄을 옮기거나 다른 일차로 보낸 결과를 저장한다.',
      '',
      '- 그 상품의 항목을 **빠짐없이** 보내야 한다. 하나라도 빠지거나 다른 상품의 항목이 섞이면 400 이다.',
      '- 같은 항목을 두 번 넣거나 한 자리(일차 · 순번)에 두 항목을 두면 400 이다. 순번은 1 이상이면 되고 이어지지 않아도 된다.',
      '- 시각은 바꾸지 않는다. 한 트랜잭션이라 중간에 실패하면 아무것도 바뀌지 않는다.',
      '- 다른 계정의 상품이면 404 다.',
    ].join('\n'),
    screen: '일정 편집 › 저장(줄을 옮기거나 더하고 지웠을 때)',
    calls: '없음 — DB 에 쓴다',
    spec: 'FR-IN-014 · API 설계 4-3',
    params: { productId: OWN_PRODUCT },
    body: {
      example: {
        items: [
          { itemId: 351, dayNo: 1, seq: 1 },
          { itemId: 352, dayNo: 1, seq: 2 },
          { itemId: 353, dayNo: 2, seq: 1 },
        ],
      },
      required: ['items'],
      fields: {
        items: '상품의 모든 항목과 새 자리',
        'items.itemId': '항목 번호',
        'items.dayNo': '옮길 일차. 1 ~ 박수+1',
        'items.seq': '그 날 안의 순번. 1 이상',
      },
    },
    responses: {
      200: { description: '자리를 옮긴 항목 수', example: { productId: 41, reordered: 3 } },
    },
    errors: [productNotFound(41)],
  },
  {
    route: 'PATCH /api/v1/items/{itemId}',
    tag: '3. 일정 입력 · 편집',
    summary: '일정 항목 수정',
    description: [
      '항목 하나의 시작 · 종료 시각, 장소명, 유형 가운데 보낸 필드만 고친다.',
      '',
      '- `endTime` 을 null 이나 빈 문자열로 보내면 종료 시각을 지운다. 검수 때 표준 체류시간으로 채워 본다.',
      '- 장소명을 바꿔도 연결된 장소는 그대로다. 다른 장소로 연결하려면 `POST /api/v1/items/{itemId}/match` 를 쓴다.',
      '- 일차 · 순번은 `PUT /api/v1/products/{productId}/items/order` 로 옮긴다.',
      '- 응답은 고친 항목이다. 좌표 · `walkId` 는 응답에서 null 이고, 저장된 값은 그대로다.',
      '- 바꿀 값이 없거나 형식이 틀리면 400, 다른 계정의 항목이면 404 다.',
    ].join('\n'),
    screen: '일정 편집 › 저장(고친 줄)',
    calls: '없음 — DB 에 쓴다',
    spec: 'FR-IN-014 · API 설계 4-3',
    params: { itemId: OWN_ITEM },
    body: {
      example: { startTime: '12:30', endTime: '13:30', placeLabel: '가람집옹심이', itemType: 'MEAL' },
      fields: {
        startTime: '시작 시각 HH:MM',
        endTime: '종료 시각 HH:MM. null 이나 빈 문자열이면 지운다',
        placeLabel: '장소명. 비울 수 없다',
        itemType: ITEM_TYPES,
      },
    },
    responses: {
      200: {
        description: '고친 항목',
        example: {
          itemId: 352,
          dayNo: 1,
          seq: 2,
          start: '12:30',
          end: '13:30',
          place: '가람집옹심이',
          itemType: 'MEAL',
          ktoContentId: null,
          matchStatus: 'PENDING',
          mapx: null,
          mapy: null,
          walkId: null,
        },
      },
    },
    errors: [itemNotFound(352)],
  },
  {
    route: 'DELETE /api/v1/items/{itemId}',
    tag: '3. 일정 입력 · 편집',
    summary: '일정 항목 삭제',
    description: [
      '항목 하나를 지운다. 같은 날 뒤 항목의 순번은 당기지 않는다 — 화면은 이어서 `PUT /api/v1/products/{productId}/items/order` 로 다시 매긴다.',
      '',
      '- 지난 검수 결과는 그대로 남는다. 이 항목을 가리키던 발견 항목은 가리킬 항목만 비워진다.',
      '- 다른 계정의 항목이면 404 다.',
    ].join('\n'),
    screen: '일정 편집 › 저장(지운 줄)',
    calls: '없음 — DB 에서 지운다',
    spec: 'FR-IN-014 · API 설계 4-3',
    params: { itemId: OWN_ITEM },
    responses: { 204: { description: '지웠다' } },
    errors: [itemNotFound(352)],
  },
];
