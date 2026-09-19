import type { Endpoint } from '../types';
import { OWN_PRODUCT, productNotFound } from './products';

const REPORT_ID = '0f3c6a52-9d1e-4b7a-8c24-5e61f0a9b3d7';
const REPORT_NOT_FOUND_MESSAGE = '요청하신 리포트를 찾을 수 없습니다.';

export const REPORT: readonly Endpoint[] = [
  {
    route: 'POST /api/v1/audit-runs/{runId}/reports',
    tag: '8. 리포트 · 출시',
    summary: '리포트 만들기',
    description: [
      '검수 결과를 PDF 리포트로 만든다. 서버에서 렌더까지 끝내고 `201` 과 `reportId` 를 준다 — 파일은 `GET /api/v1/reports/{reportId}/download` 로 받는다.',
      '',
      '- **그 상품의 가장 최근 검수 실행만** 리포트로 만든다. 일정표는 지금 일정을 읽으므로, 과거 실행으로 만들면 그때 판정과 지금 일정이 한 문서에 섞인다 — 409 로 거절하고 다시 검수하도록 안내한다.',
      '- 7개 절 — 상품 개요 · 검수 요약 · 일정표(수정 반영본) · 판정 내역과 공사 원문 근거 · 수정 이력 · 직접 확인 필요 목록 · 데이터 출처. 머리글에 적용 기준과 무시한 항목 수 · 사유를 적는다.',
      '- 판정마다 공사 원문 근거와 공식 명칭을 싣기 위해 만들 때 공사 데이터를 다시 조회한다. 한 곳을 못 읽어도 리포트는 나오고, 그 자리에 조회하지 못했다고 적는다.',
      '- **PDF 는 서버에 남기지 않는다.** 디스크에도 DB 에도 쓰지 않고 프로세스 메모리에 5분만 들고 있다가 버린다.',
      '- 화면은 차단이 0건인 결과에서만 이 버튼을 보인다. 서버는 가장 최근 실행인지만 확인한다.',
    ].join('\n'),
    screen: '검수 결과 › 03 출시 · 리포트 › 리포트 생성 · 수정 전후 비교 › 리포트 생성',
    calls:
      '공사 상세 조회 관광지마다 2콜(공통정보 · 소개정보) — 14곳이면 28콜. 비표출로 바뀐 곳은 부르지 않는다. ' +
      '지역 이름 · 걷기 길 이름은 캐시에 없을 때만 목록을 한 번씩 더 부른다',
    spec: 'FR-PA-060 · 061 · 062 · 064 · 066 · EX-AU-011 · API 설계 4-7',
    params: {
      runId: { description: '검수 실행 번호. 그 상품의 가장 최근 실행이어야 한다', example: 111 },
    },
    responses: {
      201: {
        description: 'PDF 를 만들어 5분 동안 메모리에 두었다',
        example: { reportId: REPORT_ID },
      },
    },
    errors: [
      {
        status: 404,
        reasonCode: 'NOT_FOUND',
        when: '없는 실행이거나 다른 계정의 실행 — 둘을 구분하지 않는다',
        message: REPORT_NOT_FOUND_MESSAGE,
      },
      {
        status: 409,
        reasonCode: 'REPORT_FAILED',
        when: '그 상품의 가장 최근 실행이 아님 — 다시 검수한 뒤 만든다',
        message:
          '가장 최근 검수 결과로만 리포트를 만들 수 있습니다. 그 뒤로 일정이 바뀌었을 수 있어 지금 다시 검수한 뒤 내려받아 주세요.',
      },
      {
        status: 500,
        reasonCode: 'REPORT_FAILED',
        when: 'PDF 를 그리지 못함 — 검수 결과는 그대로다',
        message: '리포트를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.',
      },
    ],
  },
  {
    route: 'GET /api/v1/reports/{reportId}/download',
    tag: '8. 리포트 · 출시',
    summary: '리포트 내려받기',
    description: [
      '`POST /api/v1/audit-runs/{runId}/reports` 가 만든 PDF 를 내려받는다. 파일 이름은 `검수리포트_{상품명}_{검수일}.pdf` 다.',
      '',
      '- **공개 링크가 아니다.** 만든 계정으로 로그인해야 받는다 — 로그인하지 않았으면 401, 다른 계정이면 404 다.',
      '- 만든 뒤 5분 안에는 여러 번 받을 수 있고, 지나면 404 다. 들고 있는 리포트가 20개를 넘으면 오래된 것부터 버린다. 없어졌으면 다시 만든다.',
      '- `Cache-Control: no-store, private` 로 브라우저와 중간 프록시가 파일을 캐시하지 않게 한다.',
    ].join('\n'),
    screen: '검수 결과 › 리포트 미리보기 › 내려받기',
    calls: '없음 — 메모리에 든 PDF 를 흘려보낸다',
    spec: 'PM-DA-007 · PM-DA-003 · API 설계 4-7',
    params: {
      reportId: { description: '리포트 만들기가 돌려준 `reportId`(UUID). 만든 뒤 5분 안에 받는다' },
    },
    responses: {
      200: { description: 'PDF 파일', contentType: 'application/pdf' },
    },
    errors: [
      {
        status: 404,
        reasonCode: 'NOT_FOUND',
        when: '5분이 지났거나 다른 계정의 리포트이거나 없는 번호 — 셋을 구분하지 않는다',
        message: REPORT_NOT_FOUND_MESSAGE,
      },
    ],
  },
  {
    route: 'POST /api/v1/products/{productId}/release',
    tag: '8. 리포트 · 출시',
    summary: '출시 승인',
    description: [
      '상품을 출시 승인하고 승인 시각(`releasedAt`)을 기록한다. 본문은 받지 않는다.',
      '',
      '- **그 상품의 가장 최근 검수 실행에 차단이 1건이라도 있으면 403 이다.** 한 번도 검수하지 않은 상품도 403 이다.',
      '- 오류 · 주의 · 확인 불가는 출시를 막지 않는다. 준비도 점수도 조건이 아니다.',
      '- 화면이 버튼을 막고, 이 API 가 막고, DB 트리거가 마지막으로 한 번 더 막는다.',
    ].join('\n'),
    screen: '검수 결과 › 03 출시 · 리포트 › 출시 승인',
    calls: '없음 — DB 만 쓴다',
    spec: 'PM-NG-002 · EX-AU-008 · DR-IN-007 · FR-AU-042 · API 설계 4-2',
    params: { productId: OWN_PRODUCT },
    responses: {
      200: {
        description: '출시 승인했다',
        example: { productId: 41, releasedAt: '2026-09-20T01:40:12.093Z' },
      },
    },
    errors: [
      {
        status: 403,
        reasonCode: 'FORBIDDEN_ACTION',
        when: '가장 최근 검수 실행에 차단이 있음',
        message: '차단 2건을 해결해야 출시할 수 있습니다.',
      },
      {
        status: 403,
        reasonCode: 'FORBIDDEN_ACTION',
        when: '검수한 적이 없는 상품',
        message: '검수하지 않은 상품은 출시할 수 없습니다. 먼저 검수를 실행해 주세요.',
      },
      productNotFound(41),
    ],
  },
];
