import type { Endpoint, ErrorDoc, ParamDoc } from '../types';
import { OWN_PRODUCT } from './products';

/*
 * GET 예시는 운영(심사용 공용 계정)의 상품 38 · 수정 이력 12 에서 받은 응답을 줄인 것이다.
 * 미리보기 · 확정 예시는 검수 실행 111 의 발견 항목 558(주문진 등대 운영시간 확인 불가)에 붙은
 * 1번 수정안 — 791m 떨어진 주문리마을로 대체 — 을 고른 경우다.
 */

const PRODUCT: Readonly<Record<string, ParamDoc>> = {
  productId: { description: '상품 번호', example: 38 },
};
const APPLICATION: Readonly<Record<string, ParamDoc>> = {
  id: { description: '수정안 적용 번호(`patchApplicationId`)', example: 12 },
};
/** 확정 · 되돌리기는 공용 계정의 일정을 바꾼다. 번호를 미리 채우지 않는다 (`products.ts` 주석) */
const OWN_APPLICATION: Readonly<Record<string, ParamDoc>> = {
  id: { description: '수정안 적용 번호(`patchApplicationId`)' },
};

const PRODUCT_NOT_FOUND: ErrorDoc = {
  status: 404,
  reasonCode: 'NOT_FOUND',
  when: '없는 상품이거나 다른 계정의 상품',
  message: '상품을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.',
};
const APPLICATION_NOT_FOUND: ErrorDoc = {
  status: 404,
  reasonCode: 'NOT_FOUND',
  when: '없는 이력이거나 다른 계정의 이력',
  message: '수정 이력을 찾을 수 없습니다. 목록을 새로 고쳐 주세요.',
};
const EMPTY_SELECTION: ErrorDoc = {
  status: 400,
  reasonCode: 'PATCH_STALE',
  when: '`selections` 가 빈 배열',
  message: '반영할 수정안을 선택해 주세요.',
};
const UNKNOWN_PATCH: ErrorDoc = {
  status: 409,
  reasonCode: 'PATCH_STALE',
  when: '이 상품의 발견 항목이 아니거나 그 항목에 없는 `patchId`',
  message: '검수 결과가 갱신되어 선택한 수정안을 찾을 수 없습니다. 새로 고친 뒤 다시 선택해 주세요.',
};

const SELECTIONS = [{ findingId: 558, patchId: 'p-1' }];
const PREVIEW_TOKEN = 'pv_8b41d0e6a93c';
const SELECTION_FIELDS = {
  selections: '고른 수정안. 문제마다 하나씩',
  'selections.findingId': '문제 번호',
  'selections.patchId': '수정안 번호(`p-1` ~ `p-3`)',
};

/** 일정 항목 한 줄 — 반영 전 (3일차 4번째 · 주문진 등대) */
const ITEM_BEFORE = {
  id: 348,
  dayNo: 3,
  seq: 4,
  startTime: '14:30',
  endTime: '15:30',
  endTimeSource: 'INPUT',
  placeLabel: '주문진 등대',
  itemType: 'SIGHT',
  ktoContentId: '129179',
  contentTypeId: 12,
  lclsSystm1: 'VE',
  lclsSystm2: 'VE01',
  lclsSystm3: 'VE010800',
  mapX: 128.83375904,
  mapY: 37.8976167,
  matchStatus: 'CONFIRMED',
  walkId: null,
  matchedBy: 'USER',
  origin: 'MANUAL',
};

/** 같은 자리 · 같은 시각에 관광지만 바뀐다. `placeLabel` 은 응답에만 얹은 공식 이름이다 */
const ITEM_AFTER = {
  ...ITEM_BEFORE,
  placeLabel: '주문리마을',
  ktoContentId: '129029',
  lclsSystm2: 'VE04',
  mapX: 128.8271158504,
  mapY: 37.8928732039,
};

export const PATCHES: readonly Endpoint[] = [
  {
    route: 'POST /api/v1/products/{productId}/patch-preview',
    tag: '수정안',
    summary: '수정안 미리보기',
    description: '고른 수정안을 적용하면 일정이 어떻게 바뀌는지 미리 보여 줍니다. 저장하지 않습니다.',
    params: PRODUCT,
    body: {
      example: { selections: SELECTIONS },
      required: ['selections'],
      fields: SELECTION_FIELDS,
    },
    responses: {
      200: {
        description: '성공',
        example: {
          previewToken: PREVIEW_TOKEN,
          conflict: { hasConflict: false, pairs: [] },
          before: [ITEM_BEFORE, '…외 15개'],
          after: [ITEM_AFTER, '…외 15개'],
          skipped: [],
        },
      },
    },
    errors: [EMPTY_SELECTION, PRODUCT_NOT_FOUND, UNKNOWN_PATCH],
  },
  {
    route: 'POST /api/v1/products/{productId}/patch-applications',
    tag: '수정안',
    summary: '수정안 적용',
    description: '고른 수정안을 일정에 적용하고 자동으로 다시 검수합니다.',
    params: { productId: OWN_PRODUCT },
    body: {
      example: { selections: SELECTIONS, previewToken: PREVIEW_TOKEN },
      required: ['selections'],
      fields: {
        ...SELECTION_FIELDS,
        previewToken: '미리보기 응답의 `previewToken`',
      },
    },
    responses: {
      202: {
        description: '요청 접수',
        example: { patchApplicationId: 13, beforeAuditRunId: 111, reauditJobId: 119, pollIntervalMs: 2000 },
      },
    },
    errors: [
      EMPTY_SELECTION,
      PRODUCT_NOT_FOUND,
      {
        status: 409,
        reasonCode: 'PATCH_STALE',
        when: '미리보기 뒤 일정이 바뀜',
        message: '미리 본 뒤 일정이 변경되었습니다. 다시 검토한 뒤 확정해 주세요.',
      },
      {
        status: 409,
        reasonCode: 'PATCH_CONFLICT',
        when: '고른 수정안끼리 충돌',
        message: '선택한 수정안 사이에 충돌이 있어 확정할 수 없습니다. 충돌하는 수정안 중 하나를 해제해 주세요.',
      },
      {
        status: 409,
        reasonCode: 'PATCH_STALE',
        when: '대상 일정이 이미 없는 수정안이 있음',
        message: '선택한 수정안의 대상 일정이 이미 변경되었습니다. 다시 검토한 뒤 확정해 주세요.',
      },
      {
        status: 409,
        reasonCode: 'PATCH_STALE',
        when: '이 상품을 검수하는 중',
        message: '검수가 진행 중입니다. 끝난 뒤 결과를 확인하고 확정해 주세요.',
      },
      UNKNOWN_PATCH,
      {
        status: 429,
        reasonCode: 'BUDGET_EXHAUSTED',
        when: '오늘 관광정보 조회 한도를 다 씀',
        message: '오늘 쓸 수 있는 관광정보 조회를 모두 썼습니다. 내일 0시부터 다시 검수할 수 있고, 일정 편집과 지난 결과 보기는 지금도 할 수 있습니다.',
      },
    ],
  },
  {
    route: 'GET /api/v1/patch-applications/{id}',
    tag: '수정안',
    summary: '수정안 적용 결과',
    description: '적용한 수정안과 적용 전후의 검수 결과 요약을 돌려줍니다.',
    params: APPLICATION,
    responses: {
      200: {
        description: '성공',
        example: {
          patchApplicationId: 12,
          productId: 38,
          appliedAt: '2026-09-19T14:31:14.040Z',
          selectedPatches: [{ patchId: 'p-1', findingId: 547 }],
          itemCount: { before: 15, after: 16 },
          before: {
            auditRunId: 108,
            executedAt: '2026-09-19T14:24:58.122Z',
            readinessScore: 85,
            counts: { blocker: 0, error: 0, warning: 3, unverified: 1 },
          },
          after: {
            auditRunId: 109,
            executedAt: '2026-09-19T14:31:14.135Z',
            readinessScore: 89,
            counts: { blocker: 0, error: 0, warning: 3, unverified: 1 },
          },
          reauditStatus: 'DONE',
          warningBanner: null,
          revertible: true,
          revertedAt: null,
        },
      },
    },
    errors: [APPLICATION_NOT_FOUND],
  },
  {
    route: 'POST /api/v1/patch-applications/{id}/revert',
    tag: '수정안',
    summary: '수정안 되돌리기',
    description: '가장 최근에 적용한 수정안을 취소하고 적용 전 일정으로 되돌립니다.',
    params: OWN_APPLICATION,
    responses: {
      200: {
        description: '성공',
        example: { patchApplicationId: 12, productId: 38, revertedAt: '2026-09-20T01:23:45.678Z', restoredAuditRunId: 108 },
      },
    },
    errors: [
      APPLICATION_NOT_FOUND,
      {
        status: 409,
        reasonCode: 'UNDO_UNAVAILABLE',
        when: '이미 되돌린 이력',
        message: '이미 되돌린 패치입니다. 되돌리기는 한 번만 할 수 있습니다.',
      },
      {
        status: 409,
        reasonCode: 'UNDO_UNAVAILABLE',
        when: '이 뒤에 반영한 이력이 또 있음',
        message: '직전에 반영한 패치만 되돌릴 수 있습니다. 이후 반영한 패치를 먼저 확인해 주세요.',
      },
    ],
  },
  {
    route: 'GET /api/v1/products/{productId}/comparison',
    tag: '수정안',
    summary: '수정 전후 비교',
    description: '가장 최근 수정안 적용 전후의 검수 결과를 항목별로 비교합니다.',
    params: PRODUCT,
    responses: {
      200: {
        description: '성공',
        example: {
          patchApplicationId: 12,
          before: { auditRunId: 108, executedAt: '2026-09-19T14:24:58.122Z' },
          after: { auditRunId: 109, executedAt: '2026-09-19T14:31:14.135Z' },
          metrics: [
            { key: 'blocker', label: '차단', before: 0, after: 0 },
            { key: 'error', label: '오류', before: 0, after: 0 },
            { key: 'warning', label: '주의', before: 3, after: 3 },
            { key: 'unverified', label: '확인 불가', before: 1, after: 1 },
            {
              key: 'deduction',
              label: '총 감점',
              before: 15,
              after: 11,
              formulaBefore: '100 − (0×25) − (0×10) − (3×4) − (1×3) = 85점',
              formulaAfter: '100 − (0×25) − (0×10) − (2×4) − (1×3) = 89점',
            },
            { key: 'readinessScore', label: '출시 준비도', before: 85, after: 89 },
            '…외 3개',
          ],
          warningBanner: null,
          evidence: {
            fetchedAt: '2026-09-19T14:31:14.135Z',
            targetContentCount: 14,
            dataFingerprint: '3d8bbf5d',
            dataFingerprintFull: '3d8bbf5d926b377d31c41ab7585163cec10b43167810958a012c82994db727db',
            rulesetVersion: '1.2.8',
            ktoModifiedAt: '20260616153731',
            delayNotice: '공사 데이터는 당일 변경분이 익일 반영되므로 출발 임박 시 운영기관 최종 확인을 권장합니다',
            source: '출처: ⓒ한국관광공사',
          },
          revertible: true,
        },
      },
    },
    errors: [
      PRODUCT_NOT_FOUND,
      {
        status: 404,
        reasonCode: 'NOT_FOUND',
        when: '비교할 수정안 적용 기록이 없음',
        message: '비교할 수정 이력이 없습니다. 수정안을 반영하면 전후를 비교할 수 있습니다.',
      },
      {
        status: 404,
        reasonCode: 'NOT_FOUND',
        when: '적용 뒤 재검수가 아직 끝나지 않음',
        message: '반영 후 재검수가 아직 끝나지 않았습니다. 검수가 끝나면 전후를 비교할 수 있습니다.',
      },
    ],
  },
];
