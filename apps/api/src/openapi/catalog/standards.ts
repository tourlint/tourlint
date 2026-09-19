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
    tag: '10. 검수 기준',
    summary: '검수 기준 · 관심 조건 조회',
    description: [
      '검수 기준 화면과 레이더의 관심 조건이 쓰는 값을 한 번에 돌려준다. 이 계정의 값만 읽는다.',
      '',
      '- `standard` — 모든 계정에 같은 표준(버전 · 등급별 감점 · R04 편중 임계치 · R07 표준값). 읽기만 한다. 표준 표 3종(기본 체류시간 · 실내 · 야외 · R10 기대 프로파일)은 화면이 공용 패키지에서 바로 읽어 여기 없다.',
      '- `company` — 이 계정이 표준보다 엄격하게 정한 R07 두 값과 변경 이력(최근 50건). 한 번도 바꾸지 않았으면 표준값이고 `updatedAt` 이 `null` 이다.',
      '- `watchKeywords` · `watchRegions` — 레이더의 관심 키워드와 관심 지역(시군구 + 달).',
      '- `ops` — 운영자가 정한 배치 시각과 다음 배치 시각. 배치가 꺼져 있으면 `nextBatchAt` 이 `null` 이다. 배치 시각 · 일일 예산 · 배치 켜기는 사용자 API 로 바꿀 수 없다.',
    ].join('\n'),
    screen: '검수 기준 — 화면을 열 때 · 레이더 — 관심 키워드 · 관심 지역',
    calls: '없음 — DB 만 읽는다',
    spec: 'FR-OP-020 · 021 · PM-DA-005 · API 설계 4-9',
    responses: {
      200: { description: '검수 기준 · 관심 조건', example: SETTINGS },
    },
  },
  {
    route: 'PUT /api/v1/settings',
    tag: '10. 검수 기준',
    summary: '회사 기준 · 관심 조건 저장',
    description: [
      '회사 기준(R07 두 값)과 관심 키워드 · 관심 지역을 저장하고, 저장된 전체 값을 `GET /settings` 와 같은 모양으로 돌려준다. 보낸 필드만 바뀐다.',
      '',
      '- 회사 기준은 **표준보다 엄격하게만** 정할 수 있다 — 연속 일정 6시간 이하, 식사 60분 이상. 느슨하면 400 `SETTING_NOT_STRICTER` 이고 아무것도 저장하지 않는다.',
      '- 바꾼 회사 기준은 다음 검수부터 적용된다. 지난 검수는 그때 적용한 기준을 함께 저장해 두어 결과가 바뀌지 않는다. R07 값이 바뀌면 변경 이력에 한 줄(언제 · 무엇을 · 전 → 후)이 쌓인다.',
      '- 관심 키워드 · 관심 지역은 보낸 목록으로 통째로 바꾼다. 각 50개까지이고, 키워드는 앞뒤 공백을 자르고 빈 값 · 중복을 뺀다.',
      '- 형식이 틀리면 400 이다(연속 일정은 1 이상 정수, 식사는 240 이하 정수, 달은 `YYYY-MM`). 규칙을 끄거나 상품마다 기준을 달리하는 입력은 없다.',
      '',
      '> 계정 전체 설정이다. 테스트 계정에서 부르면 같은 계정을 쓰는 다른 심사위원에게도 바로 적용된다. ' +
        '미리 채운 본문은 R07 을 표준값(6시간 · 60분)으로 두는 값이고, 관심 키워드 · 지역 목록은 보내지 않아 그대로 남는다.',
    ].join('\n'),
    screen: '검수 기준 › 회사 기준 › 저장 · 레이더 › 관심 키워드 추가 · 관심 지역 추가',
    calls: '없음 — DB 만 쓴다',
    spec: 'FR-OP-022 · 024 · 026 · DR-CF-006 · 008 · EX-SY-011 · FR-MO-053 · 059 · API 설계 4-9',
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
        r07SpanHours: '연속 일정 기준 시간(시간). 1 ~ 6 정수 — 표준 6시간보다 길면 400 `SETTING_NOT_STRICTER`',
        r07MealMinutes: '최소 식사 시간(분). 60 ~ 240 정수 — 표준 60분보다 짧으면 400 `SETTING_NOT_STRICTER`',
        watchKeywords: '관심 키워드 전체 목록(50개까지). 보내면 통째로 바뀐다',
        watchRegions: '관심 지역 전체 목록(50개까지). 보내면 통째로 바뀐다',
        'watchRegions.regnCd': '시도 코드 (`GET /ldong-codes`)',
        'watchRegions.signguCd': '시군구 코드 3자리. 세종처럼 시군구가 없으면 `null`',
        'watchRegions.month': '달 `YYYY-MM`',
      },
    },
    responses: {
      200: { description: '저장된 검수 기준 · 관심 조건 — `GET /settings` 와 같은 모양', example: SETTINGS },
    },
    errors: [
      {
        status: 400,
        reasonCode: 'SETTING_NOT_STRICTER',
        when: '회사 기준이 표준보다 느슨함 — 연속 일정 6시간 초과 · 식사 60분 미만',
        message: '회사 기준은 표준보다 엄격하게만 정할 수 있습니다 — 연속 일정은 6시간 이하, 식사는 60분 이상으로 맞춰 주세요.',
      },
    ],
  },
  {
    route: 'GET /api/v1/rules',
    tag: '10. 검수 기준',
    summary: '규칙 설명',
    description: [
      '검수 규칙 R01 ~ R10 의 이름 · 기본 등급 · 쓰는 데이터 · 기준값 · 실제 문장 예시를 돌려준다. 검수 기준 화면의 규칙 설명이 이 값을 그대로 쓴다.',
      '',
      '- 규칙을 끄거나 켜는 API 는 없다. 어느 계정도 규칙을 끌 수 없다.',
      '- `threshold` 는 표준 기준값이다. 회사 기준으로 조정할 수 있는 규칙은 R07 하나(`companyAdjustable: true`)이고, 이 계정의 값은 `GET /settings` 의 `company` 에 있다.',
      '- `dataSources` 는 `KTO`(관광정보) · `ITINERARY`(일정) · `KAKAO`(이동 시간) · `KMA`(날씨 예보)의 조합이다. R06 은 바뀐 내용에 따라 등급이 정해져 `defaultSeverity` 가 `null` 이다.',
      '- `rulesetVersion` 은 검수 실행마다 함께 기록되는 규칙셋 버전이다.',
    ].join('\n'),
    screen: '검수 기준 › 규칙 설명',
    calls: '없음 — 서버에 든 규칙 목록을 읽는다',
    spec: 'FR-OP-025 · PM-NG-003 · API 설계 4-5 · 5-10',
    responses: {
      200: {
        description: '규칙 10개',
        example: {
          rulesetVersion: '1.2.4',
          rules: [
            {
              code: 'R01',
              name: '휴무일 · 운영시간 충돌',
              version: '1.0.3',
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
