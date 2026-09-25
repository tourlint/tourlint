import type { Endpoint, ErrorDoc, ParamDoc } from '../types';
import { OWN_PRODUCT } from './products';

/*
 * GET 예시는 운영(심사용 공용 계정)의 상품 38 · 검수 실행 111 에서 받은 응답을 줄인 것이다.
 * 배열은 앞 한두 개만 남기고 `…외 N개` 로 줄였다. POST 응답은 코드가 돌려주는 모양을 따른다.
 */

const PRODUCT: Readonly<Record<string, ParamDoc>> = {
  productId: { description: '상품 번호', example: 38 },
};
const RUN: Readonly<Record<string, ParamDoc>> = {
  runId: { description: '검수 결과 번호(`auditRunId`)', example: 111 },
};
/** 무시 · 확인 표시는 공용 계정의 점수를 바꾼다. 번호를 미리 채우지 않는다 (`products.ts` 주석) */
const OWN_FINDING: Readonly<Record<string, ParamDoc>> = {
  id: { description: '문제 번호(`findingId`)' },
};

const PRODUCT_NOT_FOUND: ErrorDoc = {
  status: 404,
  reasonCode: 'NOT_FOUND',
  when: '없는 상품이거나 다른 계정의 상품',
  message: '상품을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.',
};
const RUN_NOT_FOUND: ErrorDoc = {
  status: 404,
  reasonCode: 'NOT_FOUND',
  when: '없는 검수 결과이거나 다른 계정의 것',
  message: '검수 결과를 찾을 수 없습니다. 목록에서 다시 선택해 주세요.',
};
const FINDING_NOT_FOUND: ErrorDoc = {
  status: 404,
  reasonCode: 'NOT_FOUND',
  when: '없는 항목이거나 다른 계정의 항목',
  message: '발견 항목을 찾을 수 없습니다. 목록을 새로 고쳐 주세요.',
};
const AUDIT_BUDGET_MESSAGE =
  '오늘 쓸 수 있는 관광정보 조회를 모두 썼습니다. 내일 0시부터 다시 검수할 수 있고, 일정 편집과 지난 결과 보기는 지금도 할 수 있습니다.';

/** 발견 항목 558 — 주문진 등대(3일차 14:30)의 운영시간을 확인할 수 없다. 791m 떨어진 주문리마을로 바꾸는 수정안이 붙었다 */
const FINDING_558 = {
  findingId: 558,
  ruleCode: 'R01',
  ruleVersion: '1.0.5',
  severity: 'UNVERIFIED',
  reasonCode: 'PARSE_MISSING',
  message: '주문진 등대 — 운영시간 정보를 확인할 수 없습니다',
  target: { itemId: 348, dayNo: 3, seq: 4, startTime: '14:30', placeLabel: '주문진 등대' },
  targetSecondary: null,
  hiddenContent: null,
  requiresExternal: false,
  externalSource: null,
  sourceBadge: 'TOURLINT_VERDICT',
  needsConfirmation: true,
  dismissible: true,
  dismissedAt: null,
  dismissReason: null,
  confirmedAt: null,
  evidenceView: {
    aiNormalized: {
      openHours: null,
      alwaysOpen: true,
      confidence: 'UNPARSED',
      weeklyClosed: [],
      unparsed: [
        {
          reason: 'CONDITIONAL',
          affects: ['openHours'],
          fragment: '야외공간 개방시간 09:00~18:00 / 실내시설 개방시간 09:00~17:00',
        },
      ],
      schemaVersion: '1.0',
    },
    verdict: { date: '2026-11-19', step: '2-4', unverified: true, needsConfirmation: true },
  },
  patches: [
    {
      type: 'REPLACE_CONTENT',
      patchId: 'p-1',
      payload: {
        mapx: 128.8271158504,
        mapy: 37.8928732039,
        lclsSystm2: 'VE04',
        ktoContentId: '129029',
        contentTypeId: 12,
        distanceMeters: 791,
        parseConfidence: null,
      },
      targetItemId: 348,
      placeName: '주문리마을',
    },
  ],
};

/** 발견 항목 559 — 상품 전체를 보는 판정(종류 쏠림)이라 `target` 에 항목이 없다 */
const FINDING_559 = {
  findingId: 559,
  ruleCode: 'R04',
  ruleVersion: '1.0.0',
  severity: 'WARNING',
  reasonCode: 'CONTENT_IMBALANCE',
  message:
    '전체 일정에 관광지 방문이 7곳으로 몰려 있어요. 해당 장소: 강릉 경포대, 경포해변, 안목해변 등. ' +
    '같은 종류를 3곳 이상 방문하면 주의가 표시됩니다. 한 곳을 다른 즐길 거리로 바꿔 보세요.',
  target: { itemId: null },
  targetSecondary: null,
  hiddenContent: null,
  requiresExternal: false,
  externalSource: null,
  sourceBadge: 'TOURLINT_VERDICT',
  needsConfirmation: false,
  dismissible: true,
  dismissedAt: null,
  dismissReason: null,
  confirmedAt: null,
  evidenceView: {
    aiNormalized: null,
    verdict: { key: '12', axis: 'contentTypeId', count: 7, scope: 'PRODUCT', threshold: 3 },
  },
  patches: [{ type: 'REMOVE_ITEM', patchId: 'p-1', payload: {}, targetItemId: 348 }],
};

export const AUDIT: readonly Endpoint[] = [
  {
    route: 'POST /api/v1/products/{productId}/audit-jobs',
    tag: '검수',
    summary: '검수 요청',
    description: '상품 일정을 다시 검수합니다. 검수는 시간이 걸리므로 받은 작업 번호로 진행 상태를 확인합니다.',
    params: { productId: OWN_PRODUCT },
    body: {
      description: '생략할 수 있다',
      optional: true,
      example: { triggerType: 'MANUAL' },
      fields: { triggerType: '요청 종류. 화면의 다시 검수는 `MANUAL`' },
    },
    responses: {
      202: {
        description: '요청 접수',
        example: {
          jobId: 118,
          status: 'QUEUED',
          productId: 38,
          progress: { done: 0, total: 0, label: '0곳 중 0곳 조회 완료' },
          auditRunId: null,
          createdAt: '2026-09-19T14:40:42.611Z',
          pollIntervalMs: 2000,
        },
      },
    },
    errors: [
      PRODUCT_NOT_FOUND,
      {
        status: 403,
        reasonCode: 'FORBIDDEN_ACTION',
        when: '검수를 시작하지 않은 상품',
        message: '기획 중인 상품입니다. 검수 시작을 먼저 눌러 주세요.',
      },
      {
        status: 422,
        reasonCode: 'PLACE_UNRESOLVED',
        unit: 'PRODUCT',
        when: '장소를 고르지 않은 항목이 남음',
        message:
          '관광지 2곳이 아직 확정되지 않았습니다. 일정 편집에서 관광지를 선택하거나 검수 대상에서 제외한 뒤 다시 요청해 주세요.',
      },
      { status: 429, reasonCode: 'BUDGET_EXHAUSTED', when: '오늘 관광정보 조회 한도를 다 씀', message: AUDIT_BUDGET_MESSAGE },
    ],
  },
  {
    route: 'GET /api/v1/audit-availability',
    tag: '검수',
    summary: '지금 검수할 수 있는지',
    description: '오늘 쓸 수 있는 관광정보 조회가 남아 검수를 시작할 수 있는지 돌려줍니다. 다 썼으면 다시 열리는 때(한국 시간 다음 날 0시)를 함께 줍니다. 화면은 이 값으로 검수 버튼을 미리 막습니다.',
    responses: {
      200: {
        description: '성공',
        example: { available: false, reasonCode: 'BUDGET_EXHAUSTED', resumesAt: '2026-10-13T00:00:00+09:00' },
      },
    },
  },
  {
    route: 'GET /api/v1/audit-jobs/{jobId}',
    tag: '검수',
    summary: '검수 진행 상태',
    description: '검수 작업의 진행 상태를 돌려줍니다. 끝나면 검수 결과 번호(`auditRunId`)가 채워집니다.',
    params: {
      jobId: { description: '검수 작업 번호', example: 118 },
    },
    responses: {
      200: {
        description: '성공',
        example: {
          jobId: 118,
          status: 'DONE',
          productId: 38,
          progress: { done: 14, total: 14, label: '14곳 중 14곳 조회 완료' },
          auditRunId: 111,
          createdAt: '2026-09-19T14:40:42.611Z',
          finishedAt: '2026-09-19T14:40:51.207Z',
        },
      },
    },
    errors: [
      {
        status: 404,
        reasonCode: 'NOT_FOUND',
        when: '없는 작업이거나 다른 계정의 작업',
        message: '검수 작업을 찾을 수 없습니다. 다시 요청해 주세요.',
      },
    ],
  },
  {
    route: 'GET /api/v1/products/{productId}/audit-runs',
    tag: '검수',
    summary: '검수 이력',
    description: '상품의 검수 결과 목록을 최신순으로 돌려줍니다. 현재 일정의 결과에는 `isCurrent: true` 가 붙습니다.',
    params: PRODUCT,
    responses: {
      200: {
        description: '성공',
        example: {
          totalCount: 13,
          runs: [
            {
              auditRunId: 111,
              isCurrent: true,
              executedAt: '2026-09-19T14:40:42.804Z',
              rulesetVersion: '1.2.8',
              readinessScore: 85,
              counts: { BLOCKER: 0, ERROR: 0, WARNING: 3, UNVERIFIED: 1 },
              isPartial: false,
              targetCount: 14,
              failedCount: 0,
            },
            '…외 12개',
          ],
        },
      },
    },
    errors: [PRODUCT_NOT_FOUND],
  },
  {
    route: 'GET /api/v1/audit-runs/{runId}',
    tag: '검수',
    summary: '검수 결과 요약',
    description: '출시 준비도 점수와 등급별 문제 수, 출시할 수 있는지를 돌려줍니다. 등급별 문제 수는 무시한 문제를 빼고 셉니다.',
    params: RUN,
    responses: {
      200: {
        description: '성공',
        example: {
          auditRunId: 111,
          productId: 38,
          executedAt: '2026-09-19T14:40:42.804Z',
          rulesetVersion: '1.2.8',
          isPartial: false,
          readinessScore: 85,
          scoreBreakdown: {
            formula: '100 − (0×25) − (0×10) − (3×4) − (1×3) = 85점',
            deduction: 15,
            weights: { ERROR: 10, BLOCKER: 25, WARNING: 4, UNVERIFIED: 3 },
            scoredCounts: { blocker: 0, error: 0, warning: 3, unverified: 1 },
          },
          settingSnapshot: { r07SpanHours: 6, r07MealMinutes: 60, standardVersion: '2026.09' },
          counts: { blocker: 0, error: 0, warning: 3, unverified: 1, dismissed: 0 },
          needsConfirmationCount: 1,
          targetCount: 14,
          failedCount: 0,
          releasable: true,
          releaseBlockedReason: null,
          evidence: {
            fetchedAt: '2026-09-19T14:40:42.804Z',
            targetContentCount: 14,
            dataFingerprint: '3d8bbf5d',
            dataFingerprintFull: '3d8bbf5d926b377d31c41ab7585163cec10b43167810958a012c82994db727db',
            rulesetVersion: '1.2.8',
            ktoModifiedAt: '20260616153731',
            delayNotice: '공사 데이터는 당일 변경분이 익일 반영되므로 출발 임박 시 운영기관 최종 확인을 권장합니다',
            source: '출처: ⓒ한국관광공사',
          },
        },
      },
    },
    errors: [RUN_NOT_FOUND],
  },
  {
    route: 'GET /api/v1/audit-runs/{runId}/findings',
    tag: '검수',
    summary: '발견된 문제 목록',
    description: '검수에서 찾은 문제와 문제마다 고칠 수 있는 수정안을 돌려줍니다.',
    params: {
      ...RUN,
      severity: {
        description: '이 등급의 문제만 받습니다',
        enum: ['BLOCKER', 'ERROR', 'WARNING', 'UNVERIFIED'],
      },
    },
    responses: {
      200: {
        description: '성공',
        example: { content: [FINDING_558, FINDING_559, '…외 2개'], totalElements: 4 },
      },
    },
    errors: [RUN_NOT_FOUND],
  },
  {
    route: 'GET /api/v1/audit-runs/{runId}/unverified',
    tag: '검수',
    summary: '직접 확인할 곳 목록',
    description: '관광정보만으로 확인하지 못해 운영기관에 직접 물어봐야 할 곳을 돌려줍니다.',
    params: RUN,
    responses: {
      200: {
        description: '성공',
        example: {
          totalCount: 1,
          items: [
            {
              findingId: 558,
              contentid: '129179',
              placeLabel: '주문진 등대',
              reason: '주문진 등대 — 운영시간 정보를 확인할 수 없습니다',
              reasonCode: 'PARSE_MISSING',
              location: { dayNo: 3, seq: 4, startTime: '14:30' },
              confirmedAt: null,
              excludedFromScore: false,
              note: null,
              targetItemId: 348,
            },
          ],
        },
      },
    },
    errors: [RUN_NOT_FOUND],
  },
  {
    route: 'POST /api/v1/audit-runs/{runId}/check-questions',
    tag: '검수',
    summary: '문의 질문 만들기 (AI)',
    description: '직접 확인할 곳마다 전화로 물어볼 질문을 AI 가 정리합니다. 저장하지 않습니다.',
    params: RUN,
    responses: {
      200: {
        description: '성공',
        example: {
          places: [
            {
              findingIds: [558],
              itemId: 348,
              visit: { dayNo: 3, date: '2026-11-19', start: '14:30' },
              tel: null,
              questions: ['11월 19일 14:30에 방문하려는데 그날 문을 여나요?', '그날은 몇 시까지 들어갈 수 있나요?'],
            },
          ],
          incomplete: null,
        },
      },
    },
    errors: [
      RUN_NOT_FOUND,
      {
        status: 429,
        reasonCode: 'BUDGET_EXHAUSTED',
        when: '오늘 관광정보 조회 한도를 다 씀',
        message: '오늘 쓸 수 있는 관광정보 조회를 모두 썼습니다. 내일 0시부터 다시 볼 수 있고, 확인 필요 목록은 지금도 볼 수 있습니다.',
      },
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
    route: 'POST /api/v1/findings/{id}/dismiss',
    tag: '검수',
    summary: '문제 무시',
    description: '문제를 사유와 함께 무시합니다. 무시한 문제는 점수 감점에서 빠집니다. 차단 등급은 무시할 수 없습니다.',
    params: OWN_FINDING,
    body: {
      example: { reason: '고객 요청 사항' },
      required: ['reason'],
      fields: {
        reason: '무시 사유(200자 이내)',
      },
    },
    responses: { 204: { description: '성공 (본문 없음)' } },
    errors: [
      {
        status: 400,
        reasonCode: 'DISMISS_REASON_REQUIRED',
        when: '사유가 없거나 공백뿐',
        message: '무시하려면 사유를 입력해 주세요.',
      },
      {
        status: 400,
        reasonCode: 'DISMISS_REASON_REQUIRED',
        when: '사유가 200자를 넘음',
        message: '무시 사유는 200자 이내로 입력해 주세요.',
      },
      {
        status: 403,
        reasonCode: 'FORBIDDEN_ACTION',
        when: '차단 등급 문제',
        message: '차단 등급은 무시할 수 없습니다. 일정을 고치거나 해당 항목을 검수에서 제외해 주세요.',
      },
      FINDING_NOT_FOUND,
    ],
  },
  {
    route: 'DELETE /api/v1/findings/{id}/dismiss',
    tag: '검수',
    summary: '무시 취소',
    description:
      '무시한 문제를 다시 감점에 넣습니다.',
    params: OWN_FINDING,
    responses: { 204: { description: '성공 (본문 없음)' } },
    errors: [FINDING_NOT_FOUND],
  },
  {
    route: 'POST /api/v1/findings/{id}/confirm',
    tag: '검수',
    summary: '확인 완료 표시',
    description: '직접 확인할 곳을 확인했다고 표시합니다. 점수는 바뀌지 않습니다.',
    params: OWN_FINDING,
    responses: { 204: { description: '성공 (본문 없음)' } },
    errors: [FINDING_NOT_FOUND],
  },
];
