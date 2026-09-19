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
  runId: { description: '검수 실행 번호(`auditRunId`)', example: 111 },
};
/** 무시 · 확인 표시는 공용 계정의 점수를 바꾼다. 번호를 미리 채우지 않는다 (`products.ts` 주석) */
const OWN_FINDING: Readonly<Record<string, ParamDoc>> = {
  id: { description: '발견 항목 번호(`findingId`). 직접 만든 상품의 것만 — 테스트 계정은 여럿이 함께 쓴다' },
};

const PRODUCT_NOT_FOUND: ErrorDoc = {
  status: 404,
  reasonCode: 'NOT_FOUND',
  when: '없는 상품이거나 다른 계정의 상품 — 둘을 구분하지 않는다',
  message: '상품을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.',
};
const RUN_NOT_FOUND: ErrorDoc = {
  status: 404,
  reasonCode: 'NOT_FOUND',
  when: '없는 실행이거나 다른 계정의 실행 — 둘을 구분하지 않는다',
  message: '검수 결과를 찾을 수 없습니다. 목록에서 다시 선택해 주세요.',
};
const FINDING_NOT_FOUND: ErrorDoc = {
  status: 404,
  reasonCode: 'NOT_FOUND',
  when: '없는 항목이거나 다른 계정의 항목 — 둘을 구분하지 않는다',
  message: '발견 항목을 찾을 수 없습니다. 목록을 새로 고쳐 주세요.',
};
const AUDIT_BUDGET_MESSAGE =
  '오늘 사용할 수 있는 공사 데이터 조회량을 모두 썼습니다. 내일 다시 시도하거나 관리자에게 예산 상향을 요청해 주세요.';

/** 발견 항목 558 — 주문진 등대(3일차 14:30)의 운영시간을 확인할 수 없다. 791m 떨어진 주문리마을로 바꾸는 수정안이 붙었다 */
const FINDING_558 = {
  findingId: 558,
  ruleCode: 'R01',
  ruleVersion: '1.0.3',
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
    tag: '6. 검수',
    summary: '검수 요청',
    description: [
      '이 상품의 일정을 규칙 R01 ~ R10 으로 검수하도록 요청한다. **검수는 비동기다** — 곧바로 `202` 와 `jobId` 를 받고, ' +
        '`GET /api/v1/audit-jobs/{jobId}` 를 `pollIntervalMs`(2초)마다 불러 `auditRunId` 가 채워지면 `GET /api/v1/audit-runs/{runId}` 로 결과를 읽는다.',
      '',
      '- 요청 때 거르는 순서 — 기획 중인 상품(검수 시작 전) 403, **장소를 아직 고르지 않은 항목이 하나라도 있으면 422 `PLACE_UNRESOLVED`**, ' +
        '오늘 공사 조회 예산을 다 썼으면 429. 거절되면 작업을 만들지 않는다.',
      '- 같은 상품에 진행 중인 작업이 있으면 새로 만들지 않고 그 작업을 돌려준다.',
      '- 검수는 동시에 3건까지 돌고 나머지는 큐에서 차례를 기다린다.',
      '- 공사 데이터를 못 받은 관광지는 그곳만 확인 불가로 남기고 나머지는 판정한다. 정보가 없다고 정상으로 판정하지 않는다.',
      '- 직접 정한 곳(검수 제외 항목)은 판정하지 않는다.',
      '- 본문은 없어도 된다. `triggerType` 은 작업에 기록만 되고(생략하면 `INITIAL`), `BATCH` 만 자동 배치처럼 예산 80% 에서 거절된다.',
    ].join('\n'),
    screen: '검수 결과 › 지금 재검수 (결과가 없으면 「검수 실행」)',
    calls:
      '요청 자체는 DB 만 쓴다. 뒤에서 도는 검수 1회 — 공사 상세 조회 관광지마다 2콜(공통정보 · 소개정보), ' +
      '카카오모빌리티 길찾기 같은 날 이어지는 두 곳마다 1콜(대중교통 상품은 0), 기상청 예보 최대 2콜(단기 · 중기), ' +
      '수정안 찾기에 공사 위치기반 목록 최대 3콜과 소개정보 최대 4콜. 사전 파서가 못 읽은 운영시간 문구만 AI 에 넘기고 결과를 캐시한다. ' +
      '공사 하루 예산(8,000건)은 요청할 때 확인한다',
    spec: 'FR-AU-021 · NF-PF-002 · FR-PL-001 · EX-AU-001 · EX-AU-004 · FR-OP-003 · 004 · API 설계 4-5 · 5-4 · 6-1',
    params: { productId: OWN_PRODUCT },
    body: {
      description: '생략할 수 있다',
      optional: true,
      example: { triggerType: 'MANUAL' },
      fields: { triggerType: '`INITIAL`(기본) · `MANUAL`(화면의 지금 재검수) · `BATCH`(예산 80% 에서 거절)' },
    },
    responses: {
      202: {
        description: '작업을 큐에 넣었다(이미 진행 중이면 그 작업). 진행률은 조회할 관광지를 센 뒤 채워진다',
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
        when: '기획 중인 상품 — 기획 화면의 「검수 시작」(`POST /api/v1/products/{productId}/handoff`)이 먼저다',
        message: '기획 중인 상품입니다. 검수 시작을 먼저 눌러 주세요.',
      },
      {
        status: 422,
        reasonCode: 'PLACE_UNRESOLVED',
        unit: 'PRODUCT',
        when: '장소를 고르지 않은 항목이 남음 — `fieldErrors` 에 항목마다 `items[항목 번호]`',
        message:
          '관광지 2곳이 아직 확정되지 않았습니다. 일정 편집에서 관광지를 선택하거나 검수 대상에서 제외한 뒤 다시 요청해 주세요.',
      },
      { status: 429, reasonCode: 'BUDGET_EXHAUSTED', when: '오늘 공사 조회 예산을 다 씀', message: AUDIT_BUDGET_MESSAGE },
      {
        status: 429,
        reasonCode: 'BUDGET_THRESHOLD',
        when: '`triggerType: "BATCH"` 로 보냈고 예산의 80% 를 넘음',
        message: AUDIT_BUDGET_MESSAGE,
      },
    ],
  },
  {
    route: 'GET /api/v1/audit-jobs/{jobId}',
    tag: '6. 검수',
    summary: '검수 진행 상태',
    description: [
      '검수 작업의 상태와 진행률을 돌려준다. 화면을 벗어났다 돌아와도 같은 `jobId` 로 이어서 본다.',
      '',
      '- `status` 는 `QUEUED` → `RUNNING` → `DONE` 또는 `FAILED` 다. `DONE` 이면 `auditRunId` 로 결과를 읽는다.',
      '- `progress` 는 공사 데이터를 받아 온 관광지 수다. 같은 곳이 일정에 두 번 나오면 한 번 세고, 값이 뒤로 가지 않는다.',
      '- 실패하면 `errorCode` 가 붙는다. 수정안 확정 뒤 재검수가 실패해도 반영한 일정은 그대로 두니, 검수를 다시 요청하면 된다.',
      '- 폴링 간격은 검수 요청 · 수정안 확정 응답의 `pollIntervalMs`(2초)를 따른다.',
    ].join('\n'),
    screen: '검수 결과 — 재검수 · 수정안 확정 뒤 진행 표시(「14곳 중 5곳 조회 완료」)',
    calls: '없음 — DB 만 읽는다',
    spec: 'FR-AU-022 · 023 · NF-PF-003 · EX-AU-003 · API 설계 4-5 · 5-4',
    params: {
      jobId: { description: '검수 요청 · 수정안 확정이 돌려준 작업 번호', example: 118 },
    },
    responses: {
      200: {
        description: '작업 상태. 아래는 끝난 작업이다 — 진행 중이면 `auditRunId` 가 `null` 이고 `finishedAt` 이 없다',
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
        when: '없는 작업이거나 다른 계정의 작업 — 둘을 구분하지 않는다',
        message: '검수 작업을 찾을 수 없습니다. 다시 요청해 주세요.',
      },
    ],
  },
  {
    route: 'GET /api/v1/products/{productId}/audit-runs',
    tag: '6. 검수',
    summary: '검수 이력',
    description: [
      '이 상품의 검수 실행을 최신순으로 최근 20건까지 돌려준다. 화면은 맨 앞 실행을 열고 그 번호로 요약 · 발견 항목 · 직접 확인할 곳을 읽는다.',
      '',
      '- 실행은 바뀌지 않는 기록이다. 고치거나 지우는 API 가 없고 DB 도 수정을 막는다. 다시 검수하면 새 실행이 쌓인다.',
      '- `readinessScore` · `counts` 는 조회할 때 다시 계산한 값이라 나중에 무시한 항목이 반영돼 있다. `counts` 는 등급별 전체 건수이고 키가 대문자다.',
      '- 부분 검수(`isPartial: true`)는 점수가 `null` 이다.',
    ].join('\n'),
    screen: '검수 결과 — 화면을 열 때 최신 실행을 고른다',
    calls: '없음 — DB 만 읽는다',
    spec: 'FR-PA-025 · 045 · PM-NG-004 · API 설계 4-5',
    params: PRODUCT,
    responses: {
      200: {
        description: '검수 이력. `totalCount` 는 돌려준 건수다',
        example: {
          totalCount: 13,
          runs: [
            {
              auditRunId: 111,
              executedAt: '2026-09-19T14:40:42.804Z',
              rulesetVersion: '1.2.4',
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
    tag: '6. 검수',
    summary: '검수 결과 요약',
    description: [
      '검수 실행 한 번의 요약 — 출시 준비도와 그 산식, 등급별 건수, 출시할 수 있는지, 검수 근거를 돌려준다.',
      '',
      '- **출시 준비도 = max(0, 100 − 차단×25 − 오류×10 − 주의×4 − 확인 불가×3).** 식은 `scoreBreakdown.formula` 에 그대로 실려 화면에서 검산할 수 있고, 가중치는 실행 때 값(`weights`)을 쓴다.',
      '- 등급은 넷이다 — 차단(`BLOCKER`) · 오류(`ERROR`) · 주의(`WARNING`) · 확인 불가(`UNVERIFIED`). 차단이 1건이라도 있으면 점수와 상관없이 `releasable: false` 다.',
      '- 무시한 항목은 감점에서 빠지고 `counts.dismissed` 로 센다(등급별 건수에는 남는다). 출발 전 최종 확인 항목도 감점하지 않는다. ' +
        '점수와 건수는 조회할 때 다시 계산하고, 저장된 실행 기록은 바뀌지 않는다.',
      '- 공사 데이터를 못 받은 관광지(`failedCount`)가 대상(`targetCount`)의 절반을 넘으면 부분 검수(`isPartial: true`)이고 점수는 `null` 이다.',
      '- `needsConfirmationCount` 는 확인 필요 표시가 붙은 항목 수다. 확인 불가 건수와 다르다.',
      '- `settingSnapshot` 은 이 실행에 적용한 기준(표준 버전 · 회사 기준 R07 두 값)이다. `evidence` 는 검수 근거 — 조회 시각 · 대상 수 · ' +
        '데이터 지문(앞 8자리와 전체) · 규칙셋 버전 · 공사 데이터 최종 수정 시각 · 반영 지연 안내 · 출처다.',
    ].join('\n'),
    screen: '검수 결과 — 출시 준비도 요약 카드 · 검수 근거',
    calls: '없음 — DB 만 읽는다',
    spec: 'FR-AU-040 ~ 050 · 065 · FR-OP-023 · API 설계 4-5 · 5-5',
    params: RUN,
    responses: {
      200: {
        description: '검수 결과 요약',
        example: {
          auditRunId: 111,
          productId: 38,
          executedAt: '2026-09-19T14:40:42.804Z',
          rulesetVersion: '1.2.4',
          isPartial: false,
          readinessScore: 85,
          scoreBreakdown: {
            formula: '100 − (0×25) − (0×10) − (3×4) − (1×3) = 85점',
            deduction: 15,
            weights: { ERROR: 10, BLOCKER: 25, WARNING: 4, UNVERIFIED: 3 },
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
            rulesetVersion: '1.2.4',
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
    tag: '6. 검수',
    summary: '발견 항목 목록',
    description: [
      '이 실행이 찾은 문제(발견 항목) 전부를 수정안 · 판단 근거와 함께 돌려준다. 페이지를 나누지 않고 저장 순서대로 준다 — 등급별 묶음과 정렬은 화면이 한다.',
      '',
      '- 판단 근거는 세 단이다 — 공사 원문 · AI 해석 · 판정. `evidenceView` 에는 **AI 해석(`aiNormalized`)과 판정 근거(`verdict`) 두 단만** 있다. ' +
        '공사 원문은 저장하지 않아서, 화면이 「판단 근거 보기」를 펼칠 때 `GET /api/v1/contents/{contentId}` 로 그 한 곳만 불러 세 단을 채운다.',
      '- `aiNormalized` 는 운영시간 · 휴무일 문구를 구조로 푼 결과와 신뢰도(`confidence`)다. 풀지 못한 조각은 `unparsed` 에 남는다.',
      '- `patches` 는 항목마다 최대 3개의 수정안이다(`TIME_SHIFT` · `REORDER` · `REPLACE_CONTENT` · `INSERT_ITEM` · `REMOVE_ITEM`). ' +
        '문구는 저장하지 않고, 대체 · 추가할 관광지 이름(`placeName`)만 볼 때 조회해 얹는다.',
      '- `dismissible` 은 차단이 아닐 때만 `true` 다. 시간 겹침 · 이동시간처럼 두 항목 사이의 문제는 `targetSecondary` 에 두 번째 항목이 온다.',
      '- 항목 하나를 가리키지 않는 판정(종류 쏠림 · 상품 구성처럼 일정 전체를 보는 것)은 `target` 이 `{"itemId": null}` 이고, 가리키던 항목이 사라졌으면 `itemId` 만 온다. ' +
        '비표출로 바뀐 관광지는 이름을 싣지 않고 `hiddenContent` 에 번호와 감지 시각만 담는다.',
      '- `sourceBadge: EXTERNAL_REFERENCE` 는 카카오모빌리티 · 기상청 값을 쓴 외부 참고 판정이다.',
    ].join('\n'),
    screen: '검수 결과 › 01 문제와 수정안',
    calls: '대체 · 추가 수정안이 가리키는 관광지 이름만 공사 공통정보로 조회한다 — 곳마다 1콜, 10분 메모리 캐시. 그런 수정안이 없으면 0콜이고 나머지는 DB 에서 읽는다',
    spec: 'FR-AU-060 · 066 · 067 · FR-AU-013 · 061 · 071 · FR-PA-001 · 003 · API 설계 4-5 · 5-6',
    params: {
      ...RUN,
      severity: {
        description: '이 등급만 본다. 생략하거나 모르는 값이면 전부 준다',
        enum: ['BLOCKER', 'ERROR', 'WARNING', 'UNVERIFIED'],
      },
    },
    responses: {
      200: {
        description: '발견 항목. `totalElements` 는 건수다',
        example: { content: [FINDING_558, FINDING_559, '…외 2개'], totalElements: 4 },
      },
    },
    errors: [RUN_NOT_FOUND],
  },
  {
    route: 'GET /api/v1/audit-runs/{runId}/unverified',
    tag: '6. 검수',
    summary: '직접 확인할 곳 목록',
    description: [
      '확인 불가 등급이거나 확인 필요 표시가 붙은 항목을 모아 돌려준다. 여행사가 운영기관에 직접 물어봐야 할 목록이다.',
      '',
      '- 관광지 이름은 사용자가 일정에 적은 이름(`placeLabel`)이다. 공사 원문 · 문의처 · 홈페이지는 싣지 않고, 화면이 항목을 펼칠 때 `GET /api/v1/contents/{contentId}` 로 한 곳씩 불러온다.',
      '- `confirmedAt` 은 「확인했어요」를 눌렀으면 `true`, 아니면 `null` 이다. 확인 표시는 점수를 바꾸지 않는다.',
      '- 출발 전 최종 확인 항목(`PRE_DEPARTURE_CHECK`)은 `excludedFromScore: true` 이고 감점하지 않는 이유를 `note` 에 적는다.',
      '- 일정 항목을 가리키지 않거나 그 항목이 사라진 판정은 `contentid` · `placeLabel` · `location` 이 `null` 이다.',
    ].join('\n'),
    screen: '검수 결과 › 02 직접 확인할 곳',
    calls: '없음 — DB 만 읽는다',
    spec: 'FR-AU-080 · 081 · 082 · FR-AU-044 · 045 · API 설계 4-5 · 5-7',
    params: RUN,
    responses: {
      200: {
        description: '직접 확인할 곳',
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
    tag: '6. 검수',
    summary: '전화로 물어볼 내용 (AI)',
    description: [
      '직접 확인할 곳을 곳마다 묶어, 방문 날짜 · 시각과 문의 전화번호, 전화로 물어볼 질문 두세 개를 AI 가 정리한다. ' +
        '**판정하지 않고 아무것도 바꾸지 않는다** — 확인 표시는 사람이 「확인했어요」(`POST /api/v1/findings/{id}/confirm`)로 남긴다.',
      '',
      '- 방문 날짜 · 시각(`visit`)과 `findingIds` 는 서버가 일정에서 채운다. 모델이 쓴 날짜는 쓰지 않는다.',
      '- 전화번호는 공사 관광정보에서 받아 온 번호만 싣는다. 도구 결과에 없던 번호는 `null` 로 바꾸고, 화면은 「등록된 전화번호가 없어요」를 보인다.',
      '- 이미 확인한 항목과 일정 항목을 가리키지 않는 판정은 뺀다. 확인할 곳이 없으면 AI 도 공사도 부르지 않고 빈 `places` 를 준다.',
      '- 실행 전 거절 — 예산 100% 면 429 `BUDGET_EXHAUSTED`, 같은 계정에서 이미 도는 중이거나 1분에 5번을 넘기면 429 `RATE_LIMIT_EXCEEDED`.',
      '- 실행한 뒤에는 거절하지 않는다. AI 실패 · 30초 초과 · 도중 예산 소진이면 끝난 곳만 담고 `incomplete: { reasonCode, itemIds }` 에 못 끝낸 곳을 적는다.',
      '- 질문과 전화번호는 저장하지 않고 로그에도 남기지 않는다.',
    ].join('\n'),
    screen: '검수 결과 › 02 직접 확인할 곳 › 물어볼 내용 만들기',
    calls:
      '곳마다 공사 공통정보 1콜, 거기 전화번호가 없으면 소개정보 1콜 더(최대 2콜 · 10분 캐시) + AI 1회(30초 상한). ' +
      '확인할 곳이 없으면 0. 공사 하루 예산이 다 찼으면 실행 전에 429',
    spec: 'FR-AG-020 ~ 022 · FR-AG-002 · EX-AG-004 · API 설계 4-11',
    params: RUN,
    responses: {
      200: {
        description: '곳마다 물어볼 내용. 못 끝낸 곳이 있으면 `incomplete` 가 채워진다',
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
        when: '오늘 공사 조회 예산을 다 씀',
        message: '오늘 쓸 수 있는 관광정보 조회를 모두 썼습니다. 내일 0시부터 다시 볼 수 있고, 확인 필요 목록은 지금도 볼 수 있습니다.',
      },
      {
        status: 429,
        reasonCode: 'RATE_LIMIT_EXCEEDED',
        when: '같은 계정에서 이미 정리하는 중 — 끝나는 시각을 몰라 `Retry-After` 가 없다',
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
    route: 'POST /api/v1/findings/{id}/dismiss',
    tag: '6. 검수',
    summary: '무시',
    description: [
      '발견 항목 하나를 사유와 함께 무시한다. 무시한 항목은 **출시 준비도 감점에서 빠지고** 건수로는 남는다(`counts.dismissed`). 사유는 리포트 머리글과 판정 내역에 찍힌다.',
      '',
      '- **차단은 무시할 수 없다** — 403 이다. 화면이 버튼을 숨기고, 이 API 가 막고, DB 제약이 한 번 더 막는다.',
      '- 사유는 필수이고 200자 이내다. 화면은 자주 쓰는 사유 셋(`고객 요청 사항` · `계약 업체 · 확정 일정` · `전화로 직접 확인함`)과 「기타」(직접 입력)를 준다. 서버는 앞뒤 공백을 지운 문자열을 저장한다.',
      '- 이미 무시한 항목에 다시 부르면 처음 무시한 시각과 사유를 그대로 둔다.',
      '- 판정 자체(등급 · 문장)는 바뀌지 않는다. 되돌리려면 `DELETE` 로 무시를 해제한다.',
    ].join('\n'),
    screen: '검수 결과 › 무시 › 사유 고르고 무시',
    calls: '없음 — DB 만 쓴다',
    spec: 'PM-NG-001 · FR-AU-046 · 047 · 068 · EX-AU-009 · 012 · API 설계 4-5',
    params: OWN_FINDING,
    body: {
      example: { reason: '고객 요청 사항' },
      required: ['reason'],
      fields: {
        reason: '무시 사유. 필수 · 200자 이내 — 프리셋 셋 중 하나이거나 직접 적은 문장',
      },
    },
    responses: { 204: { description: '무시했다. 본문 없음' } },
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
        when: '차단 등급 항목',
        message: '차단 등급은 무시할 수 없습니다. 일정을 고치거나 해당 항목을 검수에서 제외해 주세요.',
      },
      FINDING_NOT_FOUND,
    ],
  },
  {
    route: 'DELETE /api/v1/findings/{id}/dismiss',
    tag: '6. 검수',
    summary: '무시 해제',
    description:
      '무시를 풀고 사유도 함께 지운다. 그 항목은 다시 감점에 들어간다. 무시하지 않은 항목에 불러도 `204` 다.',
    screen: '검수 결과 › 무시 해제',
    calls: '없음 — DB 만 쓴다',
    spec: 'FR-AU-046 · 069 · API 설계 4-5',
    params: OWN_FINDING,
    responses: { 204: { description: '무시를 풀었다. 본문 없음' } },
    errors: [FINDING_NOT_FOUND],
  },
  {
    route: 'POST /api/v1/findings/{id}/confirm',
    tag: '6. 검수',
    summary: '확인했어요 표시',
    description: [
      '직접 확인할 곳의 항목에 「확인했어요」 표시를 남긴다. 본문을 받지 않는다 — **무엇을 확인했는지(결과)는 받지도 저장하지도 않는다.** 자체 데이터가 공사 데이터를 덮지 않게 하려는 것이다.',
      '',
      '- 점수는 그대로다. 무시와 달리 감점에서 빠지지 않는다.',
      '- 표시한 항목은 「전화로 물어볼 내용」에서 빠진다.',
      '- 두 번 눌러도 `204` 이고 처음 표시한 시각을 유지한다.',
    ].join('\n'),
    screen: '검수 결과 › 02 직접 확인할 곳 › 확인했어요',
    calls: '없음 — DB 만 쓴다',
    spec: 'FR-AU-083 · 084 · PM-NG-006 · FR-AG-022 · API 설계 4-5',
    params: OWN_FINDING,
    responses: { 204: { description: '표시했다. 본문 없음' } },
    errors: [FINDING_NOT_FOUND],
  },
];
