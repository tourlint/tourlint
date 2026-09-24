import type { Endpoint } from '../types';

/** 10. 검수 기준 */

const WATCH_KEYWORDS = ['역사', '커피'];
const WATCH_REGIONS = [{ regnCd: '51', signguCd: '150', month: '2026-11' }];

const SETTINGS = {
  standard: {
    version: '2026.09',
    weights: { BLOCKER: 25, ERROR: 10, WARNING: 4, UNVERIFIED: 3 },
    r04Threshold: 3,
    r07SpanHours: 6,
    r07MealMinutes: 60,
  },
  company: {
    r07SpanHours: 6,
    r07MealMinutes: 60,
    updatedAt: '2026-09-19T14:36:05.715Z',
    history: [
      { at: '2026-09-19T14:35:23.341Z', field: 'r07MealMinutes', from: 60, to: 90 },
      { at: '2026-09-19T14:36:05.715Z', field: 'r07MealMinutes', from: 90, to: 60 },
    ],
  },
  watchKeywords: WATCH_KEYWORDS,
  watchRegions: WATCH_REGIONS,
  ops: { batchTime: '05:00', nextBatchAt: '2026-09-21T05:00:00+09:00' },
};

export const STANDARDS: readonly Endpoint[] = [
  {
    route: 'GET /api/v1/settings',
    tag: '검수 기준',
    summary: '검수 기준 · 관심 조건 조회',
    description: '표준 기준, 회사 기준, 관심 키워드 · 관심 지역을 돌려줍니다.',
    responses: {
      200: { description: '성공', example: SETTINGS },
    },
  },
  {
    route: 'PUT /api/v1/settings',
    tag: '검수 기준',
    summary: '검수 기준 · 관심 조건 저장',
    description: '회사 기준과 관심 키워드 · 관심 지역을 저장합니다. 회사 기준은 표준보다 엄격하게만 정할 수 있습니다.',
    body: {
      description: '보낸 필드만 바뀐다. 안 보낸 필드는 지금 값을 그대로 둔다',
      example: { r07SpanHours: 6, r07MealMinutes: 60 },
      schemaFrom: {
        r07SpanHours: 6,
        r07MealMinutes: 60,
        watchKeywords: WATCH_KEYWORDS,
        watchRegions: WATCH_REGIONS,
      },
      fields: {
        r07SpanHours: '쉬지 않고 이어지는 일정의 최대 시간(1 ~ 6시간)',
        r07MealMinutes: '최소 식사 시간(60 ~ 240분)',
        watchKeywords: '관심 키워드(50개까지)',
        watchRegions: '관심 지역(50개까지)',
        'watchRegions.regnCd': '시도 코드 (`GET /ldong-codes`)',
        'watchRegions.signguCd': '시군구 코드',
        'watchRegions.month': '달 `YYYY-MM`',
      },
    },
    responses: {
      200: { description: '성공', example: SETTINGS },
    },
    errors: [
      {
        status: 400,
        reasonCode: 'SETTING_NOT_STRICTER',
        when: '회사 기준이 표준보다 느슨함',
        message: '회사 기준은 표준보다 엄격하게만 정할 수 있습니다 — 연속 일정은 6시간 이하, 식사는 60분 이상으로 맞춰 주세요.',
      },
    ],
  },
  {
    route: 'GET /api/v1/rules',
    tag: '검수 기준',
    summary: '검수 규칙 설명',
    description: '검수 규칙 10가지의 이름 · 기준 · 예시 문장을 돌려줍니다.',
    responses: {
      200: {
        description: '성공',
        example: {
          rulesetVersion: '1.2.6',
          rules: [
            {
              code: 'R01',
              name: '휴무일 · 운영시간 충돌',
              version: '1.0.5',
              defaultSeverity: 'BLOCKER',
              requiresExternal: false,
              basis: 'KTO_ONLY',
              dataSources: ['KTO'],
              threshold: '관광정보의 휴무일 · 운영시간 · 입장 마감 시각',
              example: '경포대 — 10/26(월) 매주 월요일 휴무',
              companyAdjustable: false,
            },
            {
              code: 'R07',
              name: '식사 · 휴식 누락',
              version: '1.1.0',
              defaultSeverity: 'WARNING',
              requiresExternal: false,
              basis: 'ITINERARY_ONLY',
              dataSources: ['ITINERARY'],
              threshold: '연속 6시간 · 식사 60분',
              example: '1일차 09:00~18:00 연속 9시간 중 식사(점심)가 45분으로 최소 60분보다 짧습니다. 시간을 늘리거나 뒤 일정을 미뤄 주세요.',
              companyAdjustable: true,
            },
            '…외 8개',
          ],
        },
      },
    },
  },
];
