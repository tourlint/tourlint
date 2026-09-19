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
  id: { description: '수정 이력 번호(`patchApplicationId`)', example: 12 },
};
/** 확정 · 되돌리기는 공용 계정의 일정을 바꾼다. 번호를 미리 채우지 않는다 (`products.ts` 주석) */
const OWN_APPLICATION: Readonly<Record<string, ParamDoc>> = {
  id: { description: '수정 이력 번호(`patchApplicationId`). 직접 만든 상품의 것만 — 테스트 계정은 여럿이 함께 쓴다' },
};

const PRODUCT_NOT_FOUND: ErrorDoc = {
  status: 404,
  reasonCode: 'NOT_FOUND',
  when: '없는 상품이거나 다른 계정의 상품 — 둘을 구분하지 않는다',
  message: '상품을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.',
};
const APPLICATION_NOT_FOUND: ErrorDoc = {
  status: 404,
  reasonCode: 'NOT_FOUND',
  when: '없는 이력이거나 다른 계정의 이력 — 둘을 구분하지 않는다',
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
  selections: '고른 수정안. 발견 항목마다 하나씩, 사용자가 고른 것만 보낸다',
  'selections.findingId': '발견 항목 번호',
  'selections.patchId': '그 항목 안의 수정안 번호(`p-1` ~ `p-3`)',
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
    tag: '7. 수정안',
    summary: '수정안 미리보기',
    description: [
      '고른 수정안을 반영하면 일정이 어떻게 되는지 보여 준다. **아무것도 저장하지 않는다** — 반영은 `POST /api/v1/products/{productId}/patch-applications` 로 따로 확정한다.',
      '',
      '- 발견 항목마다 수정안 하나씩, 사용자가 고른 것만 보낸다. 서버가 더하거나 빼지 않는다.',
      '- 충돌 검사 셋 — 같은 일정 항목을 두 수정안이 바꾸는가(`SAME_ITEM`), 함께 반영하면 시간이 새로 겹치는가(`TIME_OVERLAP`), 반영 순서에 따라 결과가 달라지는가(`ORDER_DEPENDENT`). ' +
        '충돌하면 `conflict.pairs` 에 `{ kind, a, b, message }` 로 두 수정안을 짝지어 적는다. 어느 쪽을 풀지는 사용자가 정한다.',
      '- `previewToken` 은 지금 일정을 해시한 값이다(서버에 저장하지 않는다). 확정 요청에 그대로 보내면 그 사이 일정이 바뀌었을 때 확정이 거절된다.',
      '- `before` · `after` 는 반영 전후의 일정 항목 전체다. 관광지가 바뀌거나 새로 들어간 항목은 `after` 의 `placeLabel` 에 공식 이름을 얹어 보여 준다.',
      '- 대상 일정이 이미 없어 반영하지 못한 수정안은 `skipped` 에 사유와 함께 남긴다.',
      '- 본문 모양이 틀리면(`selections` 가 배열이 아님 · `findingId` 나 `patchId` 가 빠짐) 400 이다.',
    ].join('\n'),
    screen: '검수 결과 › 수정안 선택 › 미리보기',
    calls: '바뀌거나 들어가는 관광지 이름만 공사 공통정보로 조회한다 — 곳마다 1콜, 10분 메모리 캐시(발견 항목 목록에서 이미 읽었으면 0콜). 나머지는 DB 에서 읽는다',
    spec: 'FR-PA-004 · 005 · 006 · 007 · 008 · EX-PA-002 · API 설계 4-6 · 5-8',
    params: PRODUCT,
    body: {
      example: { selections: SELECTIONS },
      required: ['selections'],
      fields: SELECTION_FIELDS,
    },
    responses: {
      200: {
        description: '반영했을 때의 일정. 일정은 아직 바뀌지 않았다',
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
    tag: '7. 수정안',
    summary: '수정안 확정하고 재검수',
    description: [
      '고른 수정안을 일정에 반영하고 전 규칙 재검수를 한 번 자동으로 건다. 일정 변경은 응답 전에 끝나 있고 **재검수만 뒤에서 돈다** — ' +
        '`202` 의 `reauditJobId` 를 `GET /api/v1/audit-jobs/{jobId}` 로 따라간다.',
      '',
      '- 거절 사유는 일정을 쓰기 전에 모두 본다 — 미리보기 뒤 일정이 바뀜(`previewToken` 불일치) · 수정안끼리 충돌 · 대상 일정이 사라진 수정안 · 이 상품의 검수가 도는 중 · 예산 소진. 하나라도 걸리면 일정을 건드리지 않는다.',
      '- **부분 반영은 없다.** 반영과 이력 기록은 한 트랜잭션이고, 대상이 사라진 수정안이 하나라도 있으면 통째로 거절한다.',
      '- 수정안을 몇 개 골랐든 재검수는 한 번이다. 새 검수 실행이 생기고 이전 실행은 그대로 남는다.',
      '- 재검수 결과 점수가 떨어지거나 차단이 늘어도 자동으로 되돌리지 않는다. `GET /api/v1/patch-applications/{id}` 가 경고 문구와 되돌릴 수 있는지를 준다.',
      '- `previewToken` 을 생략하면 일정 변경 검사만 건너뛴다. 충돌 · 대상 소실 검사는 그대로다.',
      '- 관광지를 바꿔도 사용자가 적은 장소명(`place_label`)은 그대로 저장한다. 새 관광지의 공식 이름은 공사 원문이라 볼 때 조회한다.',
    ].join('\n'),
    screen: '검수 결과 › 수정안 미리보기 › 확정하고 재검수',
    calls: '반영 자체는 DB 만 쓴다. 뒤에서 도는 재검수 1회가 검수 요청과 같은 외부 호출을 쓴다(공사 상세 조회 관광지마다 2콜 · 길찾기 · 예보 · 수정안 찾기). 반영 전에 공사 하루 예산을 확인한다',
    spec: 'FR-PA-020 · 022 · 024 · 025 · 027 · EX-PA-001 ~ 004 · API 설계 4-6 · 5-8',
    params: { productId: OWN_PRODUCT },
    body: {
      example: { selections: SELECTIONS, previewToken: PREVIEW_TOKEN },
      required: ['selections'],
      fields: {
        ...SELECTION_FIELDS,
        previewToken: '미리보기 응답의 값 그대로. 생략하면 일정 변경 검사만 건너뛴다',
      },
    },
    responses: {
      202: {
        description: '일정에 반영했고 재검수를 큐에 넣었다. `beforeAuditRunId` 는 반영 전 가장 최근 검수 실행이다',
        example: { patchApplicationId: 13, beforeAuditRunId: 111, reauditJobId: 119, pollIntervalMs: 2000 },
      },
    },
    errors: [
      EMPTY_SELECTION,
      PRODUCT_NOT_FOUND,
      {
        status: 409,
        reasonCode: 'PATCH_STALE',
        when: '`previewToken` 이 지금 일정과 맞지 않음 — 미리보기 뒤 일정이 바뀌었다',
        message: '미리 본 뒤 일정이 변경되었습니다. 다시 검토한 뒤 확정해 주세요.',
      },
      {
        status: 409,
        reasonCode: 'PATCH_CONFLICT',
        when: '고른 수정안끼리 충돌 — `fieldErrors` 에 충돌 쌍(`558:p-1 ↔ 559:p-1`)과 이유',
        message: '선택한 수정안 사이에 충돌이 있어 확정할 수 없습니다. 충돌하는 수정안 중 하나를 해제해 주세요.',
      },
      {
        status: 409,
        reasonCode: 'PATCH_STALE',
        when: '대상 일정이 이미 없는 수정안이 있음 — `fieldErrors` 에 수정안마다 사유',
        message: '선택한 수정안의 대상 일정이 이미 변경되었습니다. 다시 검토한 뒤 확정해 주세요.',
      },
      {
        status: 409,
        reasonCode: 'PATCH_STALE',
        when: '이 상품의 검수가 도는 중',
        message: '검수가 진행 중입니다. 끝난 뒤 결과를 확인하고 확정해 주세요.',
      },
      UNKNOWN_PATCH,
      {
        status: 429,
        reasonCode: 'BUDGET_EXHAUSTED',
        when: '재검수에 쓸 공사 예산이 없음 — 일정을 바꾸기 전에 거절한다',
        message: '오늘 사용할 수 있는 공사 데이터 조회량을 모두 썼습니다. 내일 다시 시도하거나 관리자에게 예산 상향을 요청해 주세요.',
      },
    ],
  },
  {
    route: 'GET /api/v1/patch-applications/{id}',
    tag: '7. 수정안',
    summary: '수정 이력 상세',
    description: [
      '수정안을 반영한 이력 한 건 — 고른 수정안, 반영 전후 검수 결과 요약, 재검수 상태, 경고 문구, 되돌릴 수 있는지를 돌려준다. 확정 뒤 재검수가 끝나면 화면이 이것으로 결과 배너를 그린다.',
      '',
      '- `reauditStatus` 는 재검수 결과가 붙었으면 `DONE`, 아직이면 `PENDING` 이다. 재검수가 실패해도 반영한 일정은 그대로이고, 검수를 다시 요청하면 그 결과가 붙는다.',
      '- 준비도가 떨어지거나 차단이 늘었으면 `warningBanner` 에 문구가 온다. 일정을 자동으로 되돌리지 않는다 — 되돌릴지는 사용자가 정한다.',
      '- `revertible` 은 아직 되돌리지 않았고 이 상품의 **가장 최근 반영**일 때만 `true` 다.',
      '- 점수와 건수는 조회할 때 다시 계산한 값이다.',
    ].join('\n'),
    screen: '검수 결과 — 확정하고 재검수 뒤 결과 배너(준비도 전후 · 전후 비교 · 되돌리기)',
    calls: '없음 — DB 만 읽는다',
    spec: 'FR-PA-026 · 027 · 028 · EX-PA-004 · 005 · API 설계 4-6',
    params: APPLICATION,
    responses: {
      200: {
        description: '수정 이력',
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
    tag: '7. 수정안',
    summary: '되돌리기',
    description: [
      '수정안을 반영하기 직전의 일정으로 되돌린다. **이 상품에서 가장 최근에 반영한 한 건만, 한 번만** 되돌릴 수 있다.',
      '',
      '- 반영 직전에 떠 둔 일정 스냅샷으로 일정 전체를 다시 쓴다(한 트랜잭션). 반영 뒤에 따로 고친 항목도 스냅샷대로 돌아간다.',
      '- 재검수를 돌리지 않는다. 되돌린 일정은 반영 전 검수가 판정한 바로 그 일정이라 그 결과(`restoredAuditRunId`)를 현재 결과로 가리킨다 — 공사 호출이 없다.',
      '- 그보다 앞선 반영은 되돌릴 수 없다(409). 중간 반영을 건너뛰면 그때 고른 수정안이 소리 없이 사라지기 때문이다.',
    ].join('\n'),
    screen: '검수 결과 › 결과 배너 › 되돌리기 · 수정 전후 비교 › 되돌리기',
    calls: '없음 — DB 만 쓴다',
    spec: 'FR-PA-026 · 027 · EX-PA-005 · 006 · API 설계 4-6 · 5-9',
    params: OWN_APPLICATION,
    responses: {
      200: {
        description: '되돌렸다',
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
    tag: '7. 수정안',
    summary: '수정 전후 비교',
    description: [
      '가장 최근 수정안 반영의 전후 검수 결과를 지표 아홉 줄로 견준다 — 등급 4종 건수, 총 감점(산식 포함), 출시 준비도, 총 이동시간 · 거리, 수요 적합성.',
      '',
      '- 대상은 이 상품의 가장 최근 반영 한 건이다. 반영한 적이 없거나, 그 반영을 되돌렸거나, 재검수가 아직 안 끝났으면 404 다 — 빈 비교를 만들어 주지 않는다.',
      '- 총 감점 줄은 전후 산식(`formulaBefore` · `formulaAfter`)을 함께 줘 검산할 수 있다. 건수와 점수는 조회할 때 다시 계산한 값이다.',
      '- 총 이동시간(`travelMinutes`, 분) · 거리(`travelMeters`, m)는 카카오모빌리티 값이라 외부 참고 표시(`sourceBadge: EXTERNAL_REF`)가 붙는다. 전후 어느 실행이든 그 값을 남기지 않았으면 두 줄이 빠진다.',
      '- 수요 적합성(`targetFit`)은 상품 구성 규칙(R10)이 찾은 결손 유형을 글로 옮긴 것이다. 판매량이나 시장 반응을 말하지 않는다.',
      '- 나빠졌으면 `warningBanner` 에 경고가 온다. 자동으로 되돌리지 않는다. `evidence` 는 반영 후 실행의 검수 근거다.',
    ].join('\n'),
    screen: '수정 전후 비교 (검수 결과 › 결과 배너 › 전후 비교)',
    calls: '없음 — DB 만 읽는다',
    spec: 'FR-PA-040 ~ 045 · FR-RU-084 · EX-PA-004 · 005 · API 설계 4-6 · 5-9',
    params: PRODUCT,
    responses: {
      200: {
        description: '전후 비교',
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
            rulesetVersion: '1.2.4',
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
        when: '반영한 적이 없거나 가장 최근 반영을 되돌림',
        message: '비교할 수정 이력이 없습니다. 수정안을 반영하면 전후를 견줄 수 있습니다.',
      },
      {
        status: 404,
        reasonCode: 'NOT_FOUND',
        when: '반영 후 재검수 결과가 아직 없음',
        message: '반영 후 재검수가 아직 끝나지 않았습니다. 검수가 끝나면 전후를 견줄 수 있습니다.',
      },
    ],
  },
];
