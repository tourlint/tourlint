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
  description: '일정 항목 번호',
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
    tag: '일정',
    summary: '일정 양식 내려받기',
    description: '일정 업로드에 쓰는 엑셀 양식(.xlsx)을 내려받습니다.',
    responses: {
      200: {
        description: '엑셀 파일(.xlsx)',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    },
  },
  {
    route: 'POST /api/v1/uploads/schedule',
    tag: '일정',
    summary: '엑셀 · CSV 일정 읽기',
    description: '양식에 맞춘 엑셀 또는 CSV 파일을 읽어 일정 표로 돌려줍니다. 저장하지 않습니다.',
    body: {
      contentType: 'multipart/form-data',
      example: { file: '(xlsx 또는 csv 파일)' },
      required: ['file'],
      files: ['file'],
      fields: { file: '엑셀(.xlsx) 또는 CSV 파일' },
    },
    responses: {
      201: {
        description: '성공',
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
    errors: [
      {
        status: 400,
        reasonCode: 'UPLOAD_FORMAT_INVALID',
        when: '엑셀(.xlsx) · CSV 가 아니거나 이름만 바꾼 파일',
        message: '엑셀(.xlsx) 파일로 읽을 수 없습니다. 파일 이름만 바꾼 것이 아닌지 확인하고, 지정 양식을 내려받아 작성해 주세요.',
      },
      {
        status: 413,
        reasonCode: 'UPLOAD_LIMIT_EXCEEDED',
        when: '파일이 20MB 를 넘음 — 5MB 에서 20MB 사이는 거절 사유를 담아 201 로 돌려준다',
        message: '올린 파일이 너무 큽니다. 5MB 이하로 줄여 주세요.',
      },
    ],
  },
  {
    route: 'POST /api/v1/uploads/schedule-text',
    tag: '일정',
    summary: '글로 쓴 일정 읽기',
    description: '자유롭게 쓴 일정 글을 AI 로 정리해 일정 표로 돌려줍니다. 저장하지 않습니다.',
    body: {
      example: { text: '1일차 / 10시 오죽헌 들렀다가 / 12시쯤 중앙시장에서 점심 / 2시 안목해변 / 저녁 6시 식사하고 8시 숙소' },
      required: ['text'],
      fields: { text: '일정을 적은 글(4,000자까지)' },
    },
    responses: {
      201: {
        description: '성공',
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
    tag: '일정',
    summary: '일정 항목 목록',
    description: '상품의 일정 항목을 일차 · 순서대로 돌려줍니다.',
    params: { productId: { description: '상품 번호', example: 38, type: 'integer' } },
    responses: {
      200: {
        description: '성공',
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
              lcls2: 'HS01',
              endTimeSource: 'INPUT',
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
    tag: '일정',
    summary: '일정 항목 추가',
    description: '일정에 장소 하나를 추가합니다. 관광지를 골라 넣거나 장소명을 직접 적어 넣을 수 있습니다.',
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
        afterItemId: '이 항목 다음에 넣습니다. 없으면 그 날 끝에',
        itemType: ITEM_TYPES,
        origin: '들어온 경로 — MANUAL(직접 입력) · UPLOAD(엑셀) · TEXT(메모) · PICKER(장소 담기). 없으면 MANUAL',
        content: '고른 관광지(`GET /api/v1/plan/places` 결과 값)',
        excluded: 'true 면 장소명을 둔 채 직접 정한 곳(검수 제외)으로 넣습니다. 걷기 길은 `{ walkId }` — 코스 이름은 보내지 않습니다',
        startTime: '걷기 길 · 고른 관광지를 넣을 시각 HH:MM(선택). 없으면 앞 일정 끝에 이어 채웁니다',
        endTime: '끝 시각 HH:MM(선택, startTime 과 함께). 비우면 검수가 기본 체류시간으로 채웁니다',
        'content.contentId': '관광지 번호',
        'content.contentTypeId': '관광지 유형 코드',
        'content.lcls1': '대분류 코드',
        'content.lcls2': '분류 코드',
        'content.mapx': '경도',
        'content.mapy': '위도',
      },
    },
    responses: {
      201: {
        description: '성공',
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
          lcls2: 'VE07',
          endTimeSource: 'DWELL_DEFAULT',
        },
      },
    },
    errors: [productNotFound(41)],
  },
  {
    route: 'PUT /api/v1/products/{productId}/items/order',
    tag: '일정',
    summary: '일정 순서 바꾸기',
    description: '일정 항목들의 일차와 순서를 한 번에 바꿉니다. 상품의 모든 항목을 보내야 합니다.',
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
      200: { description: '성공', example: { productId: 41, reordered: 3 } },
    },
    errors: [productNotFound(41)],
  },
  {
    route: 'PATCH /api/v1/items/{itemId}',
    tag: '일정',
    summary: '일정 항목 수정',
    description: '항목의 시작 · 종료 시각, 장소명, 유형 중 보낸 값만 수정합니다.',
    params: { itemId: OWN_ITEM },
    body: {
      example: { startTime: '12:30', endTime: '13:30', placeLabel: '가람집옹심이', itemType: 'MEAL' },
      fields: {
        startTime: '시작 시각 HH:MM',
        endTime: '종료 시각 HH:MM. 비우면 지웁니다',
        placeLabel: '장소명(필수)',
        itemType: ITEM_TYPES,
      },
    },
    responses: {
      200: {
        description: '성공',
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
    tag: '일정',
    summary: '일정 항목 삭제',
    description: '일정 항목 하나를 삭제합니다.',
    params: { itemId: OWN_ITEM },
    responses: { 204: { description: '성공 (본문 없음)' } },
    errors: [itemNotFound(352)],
  },
];
