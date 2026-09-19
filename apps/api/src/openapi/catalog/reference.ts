import { CALL_PROVIDER } from '@tourlint/shared';
import type { Endpoint } from '../types';

/** 11. 기준 코드 · 호출량 */

const KTO_UNAVAILABLE = '일시적으로 조회할 수 없습니다.';

export const REFERENCE: readonly Endpoint[] = [
  {
    route: 'GET /api/v1/ldong-codes',
    tag: '11. 기준 코드 · 호출량',
    summary: '지역 코드',
    description: [
      '지역 선택에 쓰는 법정동 코드 목록이다. `regnCd` 가 없으면 시도 목록, 있으면 그 시도의 시군구 목록을 돌려준다.',
      '',
      '- 한국관광공사 `ldongCode2` 응답을 코드 · 이름으로 옮긴다. 지역 목록을 코드에 박아 두지 않는다.',
      '- 시도 코드가 늘 2자리라고 가정하지 않는다 — 세종특별자치시는 시군구 단계가 없는 5자리 코드(`36110`)다.',
      '- 받은 목록은 서버 메모리에 둔다. 서버가 뜬 뒤 목록마다 처음 한 번만 공사를 부른다.',
    ].join('\n'),
    screen: '상품 기획 › 기본정보 › 시도 · 시군구 · 레이더 › 관심 지역',
    calls: '한국관광공사 `ldongCode2` — 서버가 뜬 뒤 시도 목록 · 시도별 시군구 목록을 처음 볼 때만 1콜. 이후는 0콜',
    spec: 'FR-IN-005 · 006 · API 설계 4-4',
    params: {
      regnCd: { description: '시도 코드. 주면 그 시도의 시군구를, 비우면 시도 목록을 돌려준다', example: '51' },
    },
    responses: {
      200: {
        description: '시도 또는 시군구 목록. 예시는 `regnCd=51`(강원특별자치도)의 시군구',
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
        when: '공사 코드 조회 실패 — 서버가 그 목록을 아직 받아 두지 못했을 때',
        message: KTO_UNAVAILABLE,
      },
    ],
  },
  {
    route: 'GET /api/v1/lcls-codes',
    tag: '11. 기준 코드 · 호출량',
    summary: '분류 코드',
    description: [
      '한국관광공사 관광정보 분류체계의 대분류 목록(숙박 · 음식 · 문화관광 등 10개)을 돌려준다.',
      '',
      '- `lclsSystmCode2` 를 조건 없이 부른 결과라 대분류뿐이다. 중분류 · 소분류는 이 API 로 받지 않는다.',
      '- 받은 목록은 서버 메모리에 둔다. 서버가 뜬 뒤 처음 한 번만 공사를 부른다.',
    ].join('\n'),
    calls: '한국관광공사 `lclsSystmCode2` — 서버가 뜬 뒤 처음 볼 때만 1콜. 이후는 0콜',
    spec: 'EI-KT-015 · API 설계 4-4',
    responses: {
      200: {
        description: '대분류 목록',
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
        when: '공사 코드 조회 실패 — 서버가 목록을 아직 받아 두지 못했을 때',
        message: KTO_UNAVAILABLE,
      },
    ],
  },
  {
    route: 'GET /api/v1/usage/budget',
    tag: '11. 기준 코드 · 호출량',
    summary: '오늘 호출 예산',
    description: [
      '오늘 한국관광공사 국문 관광정보 API 를 몇 번 불렀는지와 하루 예산 대비 소진율, 가장 많이 부른 오퍼레이션 5개를 돌려준다.',
      '',
      '- 예산은 계정별이 아니라 **서비스 전체**다. 모든 계정이 같은 인증키와 같은 하루 예산(`dailyQuota`, 운영자가 정한 값)을 나눠 쓴다.',
      '- `state` 는 `NORMAL` · `WARN`(80% 이상 — 자동 배치가 멈춘다, `batchAutoStopped: true`) · `EXHAUSTED`(100% — 새 검수 · 기획 조회 · 에이전트의 공사 호출이 429 `BUDGET_EXHAUSTED` 로 막힌다)다.',
      '- 날짜는 한국 시간으로 끊는다. `resetAt` 은 다음 초기화 시각(한국 자정)이다.',
      '- 집계값만 낸다. 무장애 · 반려동물 같은 다른 공사 서비스와 카카오 · 기상청 · AI 호출은 한도가 따로라 여기 세지 않는다 — `GET /usage/calls` 에서 본다.',
    ].join('\n'),
    calls: '없음 — 호출 기록(DB)만 센다',
    spec: 'FR-OP-003 · 004 · 005 · PM-DA-006 · API 설계 4-9 · 5-11 · 8-2',
    responses: {
      200: {
        description: '오늘 국문 관광정보 호출 예산',
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
    tag: '11. 기준 코드 · 호출량',
    summary: '호출 기록 (활용 증빙)',
    description: [
      '외부 API 호출을 날짜 · 제공자 · 오퍼레이션별로 묶은 기록이다. 공모전 API 활용 증빙으로 쓴다.',
      '',
      '- 기본은 오늘을 포함한 최근 7일(한국 날짜)이다. `from` · `to` 로 기간을, `provider` 로 제공자를 좁힌다. 날짜 형식이나 제공자 이름이 틀리면 400 이다.',
      '- 공사 서비스는 활용신청과 하루 한도가 서비스마다 따로라 나눠 센다 — `KTO`(국문 관광정보) · `KTO_WITH`(무장애) · `KTO_PET`(반려동물) · `KTO_RELATED`(연관 관광지) · `KTO_DURUNUBI`(두루누비) · `KTO_VISITOR`(방문자수). 그 밖에 `KAKAO_MOBILITY` · `KMA` · `LLM`(오퍼레이션은 용도, 예: `TODAY_BRIEF`)이 있다.',
      '- **서비스 전체 합계**이고 계정별로 나누지 않는다. 개별 호출 행 · 인증키 · 요청 파라미터는 내보내지 않는다.',
      '- 페이지를 나누지 않는다. `totalElements` 는 묶은 줄 수다.',
    ].join('\n'),
    calls: '없음 — 호출 기록(DB)만 센다',
    spec: 'FR-OP-007 · NF-OB-002 · PM-SC-005 · PM-DA-006 · API 설계 4-9',
    params: {
      from: { description: '시작일 `YYYY-MM-DD`(한국 날짜). 없으면 `to` 의 6일 전', example: '2026-09-14' },
      to: { description: '끝일 `YYYY-MM-DD`. 없으면 오늘', example: '2026-09-20' },
      provider: { description: '이 제공자만. 없으면 전부', enum: CALL_PROVIDER },
    },
    responses: {
      200: {
        description: '기간 안 호출 집계',
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
