import type { Endpoint } from '../types';
import { OWN_PRODUCT, productNotFound } from './products';

const REPORT_ID = '0f3c6a52-9d1e-4b7a-8c24-5e61f0a9b3d7';
const REPORT_NOT_FOUND_MESSAGE = '요청하신 리포트를 찾을 수 없습니다.';

export const REPORT: readonly Endpoint[] = [
  {
    route: 'POST /api/v1/audit-runs/{runId}/reports',
    tag: '리포트 · 출시',
    summary: '검수 리포트 만들기',
    description: '검수 결과를 PDF 리포트로 만들고 리포트 번호를 돌려줍니다. 현재 일정의 검수 결과로만 만들 수 있습니다.',
    params: {
      runId: { description: '검수 결과 번호. 현재 일정의 결과(`isCurrent`)여야 합니다', example: 111 },
    },
    responses: {
      201: {
        description: '성공',
        example: { reportId: REPORT_ID },
      },
    },
    errors: [
      {
        status: 404,
        reasonCode: 'NOT_FOUND',
        when: '없는 검수 결과이거나 다른 계정의 것',
        message: REPORT_NOT_FOUND_MESSAGE,
      },
      {
        status: 409,
        reasonCode: 'REPORT_FAILED',
        when: '현재 일정의 검수 결과가 아님',
        message:
          '지금 일정의 검수 결과로만 리포트를 만들 수 있습니다. 그 뒤로 일정이 바뀌었을 수 있어 지금 다시 검수한 뒤 내려받아 주세요.',
      },
      {
        status: 500,
        reasonCode: 'REPORT_FAILED',
        when: 'PDF 를 만들지 못함',
        message: '리포트를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.',
      },
      {
        status: 429,
        reasonCode: 'RATE_LIMIT_EXCEEDED',
        when: '1분에 5번을 넘김 — 공개 테스트 계정은 세지 않는다',
        message: '리포트는 1분에 5번까지 만들 수 있어요. 43초 뒤에 다시 눌러 주세요.',
      },
    ],
  },
  {
    route: 'GET /api/v1/reports/{reportId}/download',
    tag: '리포트 · 출시',
    summary: '검수 리포트 내려받기',
    description: '만든 PDF 리포트를 내려받습니다. 만든 뒤 5분 동안 받을 수 있습니다.',
    params: {
      reportId: { description: '리포트 번호' },
    },
    responses: {
      200: { description: 'PDF 파일', contentType: 'application/pdf' },
    },
    errors: [
      {
        status: 404,
        reasonCode: 'NOT_FOUND',
        when: '5분이 지났거나 다른 계정의 리포트이거나 없는 번호',
        message: REPORT_NOT_FOUND_MESSAGE,
      },
    ],
  },
  {
    route: 'POST /api/v1/products/{productId}/release',
    tag: '리포트 · 출시',
    summary: '출시 승인',
    description: '상품을 출시 승인합니다. 현재 일정의 검수 결과에 차단 문제가 있으면 승인할 수 없습니다.',
    params: { productId: OWN_PRODUCT },
    responses: {
      200: {
        description: '성공',
        example: { productId: 41, releasedAt: '2026-09-20T01:40:12.093Z' },
      },
    },
    errors: [
      {
        status: 403,
        reasonCode: 'FORBIDDEN_ACTION',
        when: '현재 일정의 검수 결과에 차단 문제가 있음',
        message: '차단 2건을 해결해야 출시할 수 있습니다.',
      },
      {
        status: 403,
        reasonCode: 'FORBIDDEN_ACTION',
        when: '검수한 적이 없는 상품',
        message: '검수하지 않은 상품은 출시할 수 없습니다. 먼저 검수를 실행해 주세요.',
      },
      {
        status: 403,
        reasonCode: 'FORBIDDEN_ACTION',
        when: '수정안을 반영하고 재검수가 끝나기 전',
        message: '수정안을 반영한 일정의 재검수가 아직 끝나지 않았습니다. 재검수 결과를 확인한 뒤 출시해 주세요.',
      },
      productNotFound(41),
    ],
  },
];
