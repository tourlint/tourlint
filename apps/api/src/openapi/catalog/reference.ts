import { CALL_PROVIDER } from '@tourlint/shared';
import type { Endpoint } from '../types';

/** 11. 기준 코드 · 호출량 */

const KTO_UNAVAILABLE = '일시적으로 조회할 수 없습니다.';

export const REFERENCE: readonly Endpoint[] = [
  {
    route: 'GET /api/v1/ldong-codes',
    tag: '코드 · 호출량',
    summary: '지역 코드',
    description: '시도 목록을 돌려줍니다. `regnCd` 를 주면 그 시도의 시군구 목록을 돌려줍니다.',
    params: {
      regnCd: { description: '시도 코드. 주면 그 시도의 시군구 목록', example: '51' },
    },
    responses: {
      200: {
        description: '성공',
        example: {
          items: [
            { code: '110', name: '춘천시' },
            { code: '150', name: '강릉시' },
          ],
        },
      },
    },
    errors: [
      {
        status: 503,
        reasonCode: 'KTO_FETCH_FAILED',
        when: '관광정보를 불러오지 못함',
        message: KTO_UNAVAILABLE,
      },
    ],
  },
  {
    route: 'GET /api/v1/lcls-codes',
    tag: '코드 · 호출량',
    summary: '관광지 분류 코드',
    description: '관광지 분류(대분류) 목록을 돌려줍니다.',
    responses: {
      200: {
        description: '성공',
        example: {
          items: [
            { code: 'AC', name: '숙박' },
            { code: 'VE', name: '문화관광' },
          ],
        },
      },
    },
    errors: [
      {
        status: 503,
        reasonCode: 'KTO_FETCH_FAILED',
        when: '관광정보를 불러오지 못함',
        message: KTO_UNAVAILABLE,
      },
    ],
  },
  {
    route: 'GET /api/v1/usage/budget',
    tag: '코드 · 호출량',
    summary: '오늘 호출량',
    description: '오늘 한국관광공사 API 호출 수와 하루 한도 대비 사용률을 돌려줍니다.',
    responses: {
      200: {
        description: '성공',
        example: {
          quotaDate: '2026-09-20',
          dailyQuota: 8000,
          used: 72,
          usageRatio: 0.009,
          state: 'NORMAL',
          batchAutoStopped: false,
          topOperations: [
            { operation: 'detailCommon2', count: 37 },
            { operation: 'detailIntro2', count: 32 },
          ],
          resetAt: '2026-09-21T00:00:00+09:00',
        },
      },
    },
  },
  {
    route: 'GET /api/v1/usage/calls',
    tag: '코드 · 호출량',
    summary: '외부 API 호출 기록',
    description: '외부 API 호출 수를 날짜 · 제공처별로 모아 돌려줍니다.',
    params: {
      from: { description: '시작일 `YYYY-MM-DD`. 없으면 7일 전', example: '2026-09-14' },
      to: { description: '끝일 `YYYY-MM-DD`. 없으면 오늘', example: '2026-09-20' },
      provider: { description: '제공처. 없으면 전부', enum: CALL_PROVIDER },
    },
    responses: {
      200: {
        description: '성공',
        example: {
          range: { from: '2026-09-14', to: '2026-09-20' },
          totals: { count: 4907, ok: 4552, fail: 74, timeout: 281 },
          content: [
            {
              quotaDate: '2026-09-20',
              provider: 'KTO',
              operation: 'detailCommon2',
              count: 37,
              okCount: 36,
              failCount: 0,
              timeoutCount: 1,
              avgLatencyMs: 499,
            },
          ],
          totalElements: 68,
        },
      },
    },
  },
];
