/**
 * TourLint 공용 상수 — 판정에 직접 쓰이는 값만 둔다.
 *
 * 근거: 용어 정의 v1.2 §7 영문 표기 대조표 · 기능 요구사항 v1.7 · 데이터 요구사항 v1.6
 *       · 예외처리 요구사항 v1.3 · 외부 연동 요구사항 v1.2
 *
 * ⚠️ 여기 값을 바꾸면 검수 판정 결과가 달라진다.
 *    변경하려면 노션 개정 → 코드 순서를 지키고 docs/기대값표.md를 함께 갱신한다.
 */

// ─────────────────────────────────────────────────────────────
// 검수 등급 (severity)
// ─────────────────────────────────────────────────────────────
export const SEVERITY = ['BLOCKER', 'ERROR', 'WARNING', 'UNVERIFIED'] as const;
export type Severity = (typeof SEVERITY)[number];

/**
 * 출시 준비도 가중치 **기본값**.
 * 실제 판정에는 user_setting.weights(계정 설정)를, 과거 실행 재계산에는
 * audit_run.weight_snapshot을 쓴다. 이 상수를 판정 경로에 직접 박지 않는다 (NF-MT-004).
 */
export const SEVERITY_WEIGHT_DEFAULT: Record<Severity, number> = {
  BLOCKER: 25,
  ERROR: 10,
  WARNING: 4,
  UNVERIFIED: 3,
};

/** 출시 준비도 = max(0, 100 − Σ(등급별 건수 × 가중치)) — FR-AU-041 */
export const READINESS_SCORE_BASE = 100;

/** @deprecated SEVERITY 를 사용한다 (용어 정의 §7 영문 표기). */
export const GRADE = SEVERITY;
/** @deprecated SEVERITY_WEIGHT_DEFAULT 를 사용한다. */
export const GRADE_WEIGHT = SEVERITY_WEIGHT_DEFAULT;

// ─────────────────────────────────────────────────────────────
// 해석 신뢰도 (parse_confidence) — CONFIRMED > ESTIMATED > UNPARSED
// ─────────────────────────────────────────────────────────────
export const PARSE_CONFIDENCE = ['CONFIRMED', 'ESTIMATED', 'UNPARSED'] as const;
export type ParseConfidence = (typeof PARSE_CONFIDENCE)[number];

// ─────────────────────────────────────────────────────────────
// 일정 항목 · 상품
// ─────────────────────────────────────────────────────────────
export const ITEM_TYPE = ['SIGHT', 'MEAL', 'LODGING', 'REST', 'MOVE', 'FREE'] as const;
export type ItemType = (typeof ITEM_TYPE)[number];

export const MATCH_STATUS = ['CONFIRMED', 'EXCLUDED', 'PENDING'] as const;
export type MatchStatus = (typeof MATCH_STATUS)[number];

export const END_TIME_SOURCE = ['INPUT', 'DWELL_DEFAULT', 'DWELL_FALLBACK'] as const;
export type EndTimeSource = (typeof END_TIME_SOURCE)[number];

export const TRANSPORT = ['CHARTER_BUS', 'CAR', 'PUBLIC_TRANSIT'] as const;
export type Transport = (typeof TRANSPORT)[number];

/** 박수 0(당일) · 1(1박 2일) · 2(2박 3일)만 허용 — SC-PD-001 · ck_product_nights */
export const NIGHTS_ALLOWED = [0, 1, 2] as const;

// ─────────────────────────────────────────────────────────────
// 규칙 판정 사유코드 15종 — 예외 사유코드와 네임스페이스가 다르다 (EX-CM-022)
// ─────────────────────────────────────────────────────────────
export const REASON_CODE = [
  'REST_DAY_CONFLICT', 'OPEN_HOUR_CONFLICT', 'ADMISSION_CUTOFF', 'IN_BREAK_TIME',
  'REST_DAY_UNCERTAIN', 'EVENT_ENDED', 'EVENT_NOT_STARTED', 'TIME_OVERLAP',
  'CONTENT_IMBALANCE', 'MEAL_REST_MISSING', 'MEAL_TIME_SHORT', 'TRAVEL_TIME_SHORT',
  'RAIN_RISK', 'TARGET_MISMATCH', 'PRE_DEPARTURE_CHECK',
] as const;
export type ReasonCode = (typeof REASON_CODE)[number];

// ─────────────────────────────────────────────────────────────
// 예외 사유코드 39종 — 문자열 하드코딩 금지 (EX-CM-020)
// ─────────────────────────────────────────────────────────────
export const EXCEPTION_REASON_CODE = [
  'UPLOAD_FORMAT_INVALID', 'UPLOAD_ROW_INVALID', 'UPLOAD_LIMIT_EXCEEDED',
  'DAY_COUNT_MISMATCH', 'NL_STRUCTURE_FAILED',
  'PLACE_NOT_FOUND', 'PLACE_UNRESOLVED',
  'PARSE_MISSING', 'PARSE_TARGET_VARIES', 'PARSE_REFERENCE', 'PARSE_CONDITIONAL',
  'PARSE_SCHEMA_INVALID', 'LLM_UNAVAILABLE',
  'KTO_FETCH_FAILED', 'CONTENT_NOT_FOUND', 'KTO_AUTH_ERROR', 'KTO_QUOTA_EXCEEDED',
  'CONTENT_HIDDEN', 'COORD_MISSING',
  'ROUTE_NOT_FOUND', 'ROUTE_PROVIDER_FAILED', 'TRANSIT_NOT_SUPPORTED',
  'FORECAST_UNAVAILABLE', 'CLIMATE_DATA_MISSING',
  'AUDIT_PARTIAL', 'AUDIT_TIMEOUT',
  'PATCH_CONFLICT', 'PATCH_STALE', 'UNDO_UNAVAILABLE',
  'FINGERPRINT_INCOMPARABLE',
  'BATCH_EMPTY', 'BATCH_HIDDEN_OVERFLOW', 'BUDGET_THRESHOLD', 'BUDGET_EXHAUSTED',
  'FORBIDDEN_ACTION', 'NOT_AUTHENTICATED', 'NOT_FOUND', 'REPORT_FAILED', 'INTERNAL_ERROR',
] as const;
export type ExceptionReasonCode = (typeof EXCEPTION_REASON_CODE)[number];

/** 예외 처리 단위 8종 — 모든 예외는 이 중 하나를 가진다 (EX-CM-001) */
export const EXCEPTION_UNIT = [
  'FRAGMENT', 'SEGMENT', 'CONTENT', 'RULE', 'ITEM', 'PRODUCT', 'REQUEST', 'BATCH',
] as const;
export type ExceptionUnit = (typeof EXCEPTION_UNIT)[number];

/** unparsed[].reason 열거 — PARSE_* 예외코드와 별개의 값이다 (DR-NM 5-3) */
export const UNPARSED_REASON = [
  'MISSING', 'TARGET_VARIES', 'REFERENCE', 'CONDITIONAL', 'SCHEMA_INVALID', 'LLM_UNAVAILABLE',
] as const;
export type UnparsedReason = (typeof UNPARSED_REASON)[number];

// ─────────────────────────────────────────────────────────────
// 판정 정의 상수 — 설정 화면에 노출하지 않는다 (기능 요구사항 v1.6)
// 사용자가 바꾸면 판정 기준 자체가 달라져 결정론성 비교가 깨진다.
// ─────────────────────────────────────────────────────────────
export const RULE_CONSTANTS = {
  /** R03 최소 중복 — 1분이라도 겹치면 중복으로 판정 */
  R03_MIN_OVERLAP_MINUTES: 1,
  /** R08 이동 여유 버퍼 — 예상 이동시간이 배정 시간을 넘으면 즉시 오류 */
  R08_TRAVEL_BUFFER_MINUTES: 0,
  /** R09 야외 비중 임계 — (야외 + 혼재×0.5) ÷ 전체 */
  R09_OUTDOOR_RATIO_THRESHOLD: 0.6,
  /** R09 강수 임계 — 단기·중기 예보 강수확률 */
  R09_FORECAST_RAIN_THRESHOLD: 0.6,
  /** R09 강수 임계 — 평년 강수일수 비율 */
  R09_CLIMATE_RAIN_THRESHOLD: 0.3,
  /** R09 혼재(MIXED) 가중치 */
  R09_MIXED_WEIGHT: 0.5,
  /** R10 야간 콘텐츠 판별 기준 시각 */
  R10_NIGHT_SLOT_FROM: '19:00',
} as const;

/**
 * 신분류체계 **중분류별 기본 체류시간(분)** 초기값 (FR-IN-011 · FR-OP-021 · DR-CF-002).
 *
 * 종료시간이 입력되지 않은 항목을 이 표로 보완한 뒤 R03 중복을 판정한다 (FR-RU-031).
 * 매핑이 없는 중분류에는 `SETTING_DEFAULTS.dwellFallbackMinutes`(90분)를 적용한다.
 *
 * ⚠️ **소요시간을 공사 데이터에서 취득한다고 전제하지 않는다.** 2026.08.12 실호출에서
 *    반복정보 조회에 소요시간 필드가 없었고, 문화시설(14)의 `spendtime` 은 빈 문자열이었다
 *    (EI-KT-020). 이 표가 유일한 근거다.
 *
 * ⚠️ **숙박(`AC*`)에는 체류시간을 두지 않는다** (FR-AU-011). 입실 · 퇴실만 해석하므로
 *    보완 대상이 아니다. 잘못 보완하면 입실 17:30 + 90분 = 19:00 구간이 생겨
 *    **없는 시간 중복**이 만들어진다.
 *
 * 픽스처 22건이 실제로 쓰는 8개만 담는다. 나머지는 W3 에 59행으로 채운다.
 */
export const DWELL_MINUTES_SEED: Readonly<Record<string, number>> = {
  HS01: 60,  // 역사관광지 — 경포대 · 굴산사지
  VE03: 60,  // 자연공원 — 강남축구공원 · 3·1운동기념공원 · 남산공원
  VE07: 90,  // 박물관 · 기념관 — 오죽헌·시립박물관 · 갈골한과체험전시관
  VE12: 90,  // 문화체험 — 한복 문화 창작소
  EX06: 90,  // 체험시설 — 녹색도시체험센터
  EV01: 120, // 축제 — 경포벚꽃축제 · 강릉커피축제
  FD01: 60,  // 음식점
  SH06: 60,  // 시장 — 농산물도매시장 · 동부시장
};

/** 실내 · 야외 구분 초기값. R09 야외 비중 계산에만 쓴다 (FR-RU-090 · FR-OP-021) */
export const INDOOR_OUTDOOR = ['INDOOR', 'OUTDOOR', 'MIXED'] as const;
export type IndoorOutdoor = (typeof INDOOR_OUTDOOR)[number];

export const INDOOR_OUTDOOR_SEED: Readonly<Record<string, IndoorOutdoor>> = {
  HS01: 'OUTDOOR', VE03: 'OUTDOOR', VE07: 'MIXED', VE12: 'INDOOR',
  EX06: 'INDOOR', EV01: 'OUTDOOR', FD01: 'INDOOR', SH06: 'MIXED',
  AC01: 'INDOOR', AC03: 'INDOOR', AC05: 'MIXED', AC06: 'INDOOR',
};

/** 계정 설정 기본값 — 실제 판정에는 user_setting 값을 쓴다 */
export const SETTING_DEFAULTS = {
  r07SpanHours: 6,
  r07MealMinutes: 60,
  r04Threshold: 3,
  /** 중분류 미매핑 시 적용하는 기본 체류시간 (FR-IN-011) */
  dwellFallbackMinutes: 90,
} as const;

/** 전역 운영 설정 기본값 (system_setting) */
export const SYSTEM_SETTING_DEFAULTS = {
  batchTime: '05:00',
  batchEnabled: false,
  dailyQuota: 800,
} as const;

/** 예산 게이트 경계 — 80% 배치 중지 / 100% 신규 검수 차단 (FR-OP-003·004) */
export const BUDGET_THRESHOLD_RATIO = { WARN: 0.8, EXHAUSTED: 1.0 } as const;

/** 부분 검수 승격 조건 — 실패 콘텐츠가 이 비율을 **초과**하면 점수 미산출 (FR-AU-029) */
export const PARTIAL_AUDIT_FAILURE_RATIO = 0.5;

// ─────────────────────────────────────────────────────────────
// 운영정보 해석기 커버리지 통과 기준 (FR-AU-004 v1.7 · DR-TD-003 v1.6)
// 커버리지 = 해석 성공 조각 ÷ (전체 − 결측). 결측은 분모에서 제외한다.
// ─────────────────────────────────────────────────────────────
export const PARSER_COVERAGE = {
  target: 0.9,
  total: 287,
  restDay: { missing: 48, denominator: 239, passing: 216 },
  openHours: { missing: 21, denominator: 266, passing: 240 },
} as const;

// ─────────────────────────────────────────────────────────────
// 공사 콘텐츠 유형과 필드 분기
// ─────────────────────────────────────────────────────────────
export const CONTENT_TYPE_ID = [12, 14, 15, 28, 32, 38, 39] as const;
export type ContentTypeId = (typeof CONTENT_TYPE_ID)[number];

/** 유닛 구분자 U+001F — 지문 생성 시 필드 사이 구분자 (DR-FP-002) */
export const UNIT_SEPARATOR = '\u001F';

/**
 * contentTypeId별 지문 입력 필드와 **이어붙임 순서**. 순서를 바꾸면 해시가 달라진다 (DR-FP-002).
 * 값은 전처리하지 않은 원문 그대로 사용하며 null은 빈 문자열로 치환한다 (DR-FP-004·005).
 */
export const FINGERPRINT_FIELDS: Readonly<Record<ContentTypeId, readonly string[]>> = {
  12: ['restdate', 'usetime'],
  14: ['restdateculture', 'usetimeculture'],
  15: ['eventstartdate', 'eventenddate', 'playtime'],
  28: ['restdateleports', 'usetimeleports'],
  32: ['checkintime', 'checkouttime'],
  38: ['restdateshopping', 'opentime'],
  39: ['restdatefood', 'opentimefood'],
};

/**
 * detailIntro2 응답의 contentTypeId별 필드 분기 (EI-KT §3-3, 실측 확정).
 * rest 가 null 인 유형은 R01 휴무 판정 대상이 아니다 (15 축제 · 32 숙박).
 */
export const INTRO_FIELDS: Readonly<
  Record<ContentTypeId, { rest: string | null; use: readonly string[]; contact: string }>
> = {
  12: { rest: 'restdate', use: ['usetime'], contact: 'infocenter' },
  14: { rest: 'restdateculture', use: ['usetimeculture'], contact: 'infocenterculture' },
  15: { rest: null, use: ['playtime'], contact: 'sponsor1tel' },
  28: { rest: 'restdateleports', use: ['usetimeleports'], contact: 'infocenterleports' },
  32: { rest: null, use: ['checkintime', 'checkouttime'], contact: 'infocenterlodging' },
  38: { rest: 'restdateshopping', use: ['opentime'], contact: 'infocentershopping' },
  39: { rest: 'restdatefood', use: ['opentimefood'], contact: 'infocenterfood' },
};

/** 사용 오퍼레이션 9종 — 이외 호출 금지 (EI-KT-001) */
export const KTO_OPERATIONS = [
  'searchKeyword2', 'detailCommon2', 'detailIntro2', 'searchFestival2',
  'areaBasedSyncList2', 'areaBasedList2', 'locationBasedList2',
  'ldongCode2', 'lclsSystmCode2',
] as const;
export type KtoOperation = (typeof KTO_OPERATIONS)[number];

/** 위치기반 조회 반경 상한 (SC-DT-013 · EI-KT-008) */
export const LOCATION_RADIUS_MAX_METERS = 20000;
