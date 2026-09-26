import { CONCEPT_LABEL, TARGET_LABEL, type ConceptKey, type TargetKey } from './target-profile';
import { LCLS_SYSTM2 } from './lcls-systm';
import { ktoFieldLabel } from './constants';

/**
 * 판정 입력값을 사람 말로 (FR-AU-061 판단 근거 3단 · #478).
 *
 * 규칙이 `finding.evidence` 에 담은 것을 화면이 그대로 펼치고 있었다. 키도 값도 영어였고,
 * 객체는 `[object Object]` 로 나왔다 — 영어 키보다 나쁘다. 값이 아예 안 보인다.
 *
 * 어휘를 여기 두는 이유는 **키를 만드는 쪽이 규칙엔진**이기 때문이다. 화면에 두면
 * 리포트가 이 블록을 쓰게 될 때 또 갈린다 (#473 · #475 에서 두 번 겪었다).
 *
 * ## 세 갈래로 나눈다
 *
 * - **버린다** — 실무자에게 뜻이 없는 내부 값. 등급 배지와 판정 문장이 이미 말한다
 * - **옮긴다** — 이름표와 값을 사람 말로. 객체는 한 줄로 편다
 * - **그대로 둔다** — 모르는 키는 키 이름으로 남긴다. 이름이 없다고 근거를 숨기지 않는다
 */

export interface VerdictRow {
  readonly label: string;
  readonly value: string;
}

/** 실무자에게 뜻이 없는 내부 값. 판정 문장과 등급 배지가 같은 것을 이미 말한다 */
const INTERNAL = new Set([
  'needsConfirmation', 'unverified', 'step', 'scope', 'axis', 'key', 'itemIds',
  'source', 'gatedFrom', 'unit', 'exceptionReasonCode', 'isolated', 'matchStatus',
  'ktoContentId', 'normalized', 'futureBased',
  // 같은 기간을 `range` 가 이미 글로 적는다
  'eventPeriod',
  // 분포는 판정 문장이 말한다. 코드를 늘어놓으면 오히려 못 읽는다
  'lcls2Counts', 'lcls3Counts', 'contentTypeCounts',
]);

const WEEKDAY: Readonly<Record<string, string>> = {
  MON: '월요일', TUE: '화요일', WED: '수요일', THU: '목요일',
  FRI: '금요일', SAT: '토요일', SUN: '일요일',
};

const VERDICT: Readonly<Record<string, string>> = {
  CLOSED: '휴무일', OPEN: '영업일', ENDED: '끝난 행사', NOT_STARTED: '아직 열지 않은 행사',
  ONGOING: '기간 안', OUT_OF_HOURS: '운영시간 밖', IN_BREAK: '쉬는 시간',
  // R06 은 지문 비교 결과를 그대로 담는다
  HIDDEN: '공사에서 표출 중단', CHANGED: '정보 바뀜',
  FIRST: '첫 검수', UNCHANGED: '그대로', INCOMPARABLE: '비교할 이력 없음',
};

/** 명절 · 법정공휴일 (정규화 `HOLIDAY_RULES`). 화면의 AI 해석 칸도 같은 말을 쓴다 (#848) */
export const HOLIDAY_LABEL: Readonly<Record<string, string>> = {
  LUNAR_NEW_YEAR: '설날', CHUSEOK: '추석', LEGAL_HOLIDAY: '법정공휴일',
};

/** R09 강수 판정 근거 (EI-WX · 5-1 3단) */
const RAIN_SOURCE: Readonly<Record<string, string>> = {
  SHORT: '단기예보', MID: '중기예보', CLIMATE: '평년',
};

const CONFIDENCE: Readonly<Record<string, string>> = {
  CONFIRMED: '확정', ESTIMATED: '확실하지 않아요', UNPARSED: '확인 불가',
};

const ITEM_TYPE: Readonly<Record<string, string>> = {
  SIGHT: '관광', MEAL: '식사', LODGING: '숙박', REST: '휴식', MOVE: '이동', FREE: '자유',
};

/** 한 줄짜리 이름표. 값 손질이 필요 없는 키들 */
const LABEL: Readonly<Record<string, string>> = {
  date: '방문일',
  visitDate: '방문일',
  range: '행사 기간',
  nightSlotFrom: '저녁 기준 시각',
  // 출발 전 운영기관 최종 확인 (R05 · FR-AU-085 · #808)
  auditDate: '검수한 날',
  startDate: '출발일',
};

/** 분 단위 값 — `30` 을 `30분` 으로 */
const MINUTES: Readonly<Record<string, string>> = {
  overlapMinutes: '겹치는 시간',
  mealMinutes: '식사 시간',
  neededMinutes: '필요한 시간',
  allowedMinutes: '허용 시간',
  bufferMinutes: '여유 시간',
  shortfallMinutes: '모자란 시간',
};

/** 곳 수 — `4` 를 `4곳` 으로 */
const PLACES: Readonly<Record<string, string>> = {
  count: '같은 종류 수',
  threshold: '기준',
  judgedCount: '판정한 곳',
  // 야외 비중의 분모다 — 야외 · 혼재 · 실내를 다 합친 수이지 야외 수가 아니다 (#502)
  mappedCount: '실내 · 야외를 가린 곳',
  unmappedCount: '실내 · 야외를 모르는 곳',
  indoorCount: '실내로 센 곳',
};

/** 비율 — `0.62` 를 `62%` 로 */
const PERCENT: Readonly<Record<string, string>> = {
  outdoorRatio: '야외 비중',
  outdoorRatioThreshold: '야외 비중 기준',
  rainProbability: '강수확률',
  rainThreshold: '강수확률 기준',
};

function timeRange(v: unknown, from: string, to: string): string | null {
  if (!isRecord(v)) return null;
  const a = text(v[from]);
  const b = text(v[to]);
  return a === '' || b === '' ? null : `${a}~${b}`;
}

function lclsNames(v: unknown): string | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  return v
    .filter((c): c is string => typeof c === 'string')
    .map((c) => LCLS_SYSTM2[c]?.name ?? c)
    .join(' · ');
}

/**
 * 판정 입력값을 줄로 편다.
 *
 * 순서는 담긴 순서를 따른다 — 규칙이 적은 차례가 곧 판정한 차례다.
 */
export function verdictRows(evidence: unknown): VerdictRow[] {
  if (!isRecord(evidence)) return [];
  const rows: VerdictRow[] = [];

  for (const [key, raw] of Object.entries(evidence)) {
    if (raw === null || raw === undefined || raw === '') continue;
    if (INTERNAL.has(key)) continue;

    const row = toRow(key, raw);
    if (row !== null) rows.push(row);
  }
  return rows;
}

function toRow(key: string, raw: unknown): VerdictRow | null {
  if (key in LABEL) return { label: LABEL[key] as string, value: text(raw) };
  if (key in MINUTES) return { label: MINUTES[key] as string, value: `${text(raw)}분` };
  if (key in PLACES) return { label: PLACES[key] as string, value: `${text(raw)}곳` };
  if (key in PERCENT) return { label: PERCENT[key] as string, value: `${Math.round(Number(raw) * 100)}%` };

  switch (key) {
    case 'dayOfWeek': return { label: '요일', value: WEEKDAY[text(raw)] ?? text(raw) };
    case 'verdict': return { label: '판정', value: VERDICT[text(raw)] ?? text(raw) };
    case 'confidence': return { label: '신뢰도', value: CONFIDENCE[text(raw)] ?? text(raw) };
    case 'restItemType': return { label: '쉬는 항목', value: ITEM_TYPE[text(raw)] ?? text(raw) };
    case 'targetKey': return { label: '타깃', value: TARGET_LABEL[raw as TargetKey] ?? text(raw) };
    case 'conceptKey': return { label: '콘셉트', value: CONCEPT_LABEL[raw as ConceptKey] ?? text(raw) };
    case 'distanceMeters': return { label: '거리', value: `${Math.round(Number(raw) / 100) / 10}km` };

    case 'hasNight': return { label: '저녁 일정', value: raw === true ? '있음' : '없음' };
    case 'expectsNight': return { label: '저녁 일정 기대', value: raw === true ? '있음' : '없음' };

    case 'dayNo': return { label: '일차', value: `${text(raw)}일차` };
    case 'rainSource': return { label: '예보 종류', value: RAIN_SOURCE[text(raw)] ?? text(raw) };
    // 평년 경로에서만 담긴다. 조건부 스프레드로 들어가 #480 에서 빠졌다 (#502)
    case 'rainDays': return { label: '평년 강수일수', value: `${text(raw)}일` };
    case 'normalMonth': return { label: '평년 기준 달', value: `${text(raw)}월` };
    // 예보를 못 받아 평년표로 내려온 날만 담긴다 (EI-WX-006 · #797)
    case 'forecastDowngradedFrom': return { label: '받지 못한 예보', value: RAIN_SOURCE[text(raw)] ?? text(raw) };
    // 출발 1일 이내에만 담긴다 (R05 · FR-AU-085 · #808)
    case 'daysToDeparture': return { label: '출발', value: raw === 0 ? '오늘' : raw === 1 ? '내일' : `${text(raw)}일 뒤` };
    case 'on': {
      // R01 조건부 휴관이 해당하는 날 — `MM-DD` 또는 명절 규칙이다 (DR-NM-022)
      if (!Array.isArray(raw) || raw.length === 0) return null;
      const days = raw
        .filter((v): v is string => typeof v === 'string')
        .map((v) => HOLIDAY_LABEL[v] ?? v);
      return days.length === 0 ? null : { label: '해당 날짜', value: days.join(' · ') };
    }
    case 'showFlagTurnedOff': return { label: '비표출로 바뀜', value: raw === true ? '예' : '아니오' };
    case 'fieldNamesChanged': {
      // 바뀐 자리도 사람 말로 — 근거 표와 같은 이름표를 쓴다 (#475)
      if (!Array.isArray(raw) || raw.length === 0) return null;
      const names = raw.filter((v): v is string => typeof v === 'string').map(ktoFieldLabel);
      return names.length === 0 ? null : { label: '바뀐 항목', value: names.join(' · ') };
    }

    case 'hours': {
      const v = timeRange(raw, 'open', 'close');
      return v === null ? null : { label: '운영시간', value: v };
    }
    case 'visit': {
      const v = timeRange(raw, 'start', 'end');
      return v === null ? null : { label: '방문 시각', value: v };
    }
    case 'first': {
      const v = timeRange(raw, 'start', 'end');
      return v === null ? null : { label: '앞 일정', value: v };
    }
    case 'second': {
      const v = timeRange(raw, 'start', 'end');
      return v === null ? null : { label: '뒤 일정', value: v };
    }
    case 'span': {
      const v = timeRange(raw, 'from', 'to');
      if (v === null) return null;
      const m = isRecord(raw) ? text(raw.minutes) : '';
      return { label: '연속 일정', value: m === '' ? v : `${v} · ${m}분` };
    }
    case 'thresholds': {
      if (!isRecord(raw)) return null;
      const parts = [
        text(raw.spanHours) === '' ? '' : `연속 ${text(raw.spanHours)}시간`,
        text(raw.mealMinutes) === '' ? '' : `식사 ${text(raw.mealMinutes)}분`,
      ].filter((s) => s !== '');
      return parts.length === 0 ? null : { label: '기준', value: parts.join(' · ') };
    }

    case 'missingLcls2': {
      const v = lclsNames(raw);
      return v === null ? null : { label: '일정에 없는 종류', value: v };
    }
    case 'expectedLcls2': {
      const v = lclsNames(raw);
      return v === null ? null : { label: '자주 넣는 종류', value: v };
    }

    default: {
      // 모르는 키는 키 이름 그대로. 객체는 뜻을 지어내지 않고 통째로 버린다
      const v = text(raw);
      return v === '' ? null : { label: key, value: v };
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => text(x)).filter((s) => s !== '').join(' · ');
  return '';
}

/**
 * 이 키를 사람 말로 옮길 줄 아는가 (#480).
 *
 * 규칙이 새 키를 담았는데 이름표를 빠뜨리면 그 키가 화면에 영어로 찍힌다. 그걸 잡는
 * 검사가 `apps/api` 에 있다 — 규칙 소스를 긁어 여기에 다 물어본다.
 */
export function isHandledVerdictKey(key: string): boolean {
  if (INTERNAL.has(key)) return true;
  if (key in LABEL || key in MINUTES || key in PLACES || key in PERCENT) return true;
  return HANDLED_CASES.has(key);
}

/** `toRow` 의 `switch` 가 이름으로 다루는 키. 둘이 어긋나면 가드가 거짓을 말한다 */
const HANDLED_CASES = new Set([
  'dayOfWeek', 'verdict', 'confidence', 'restItemType', 'targetKey', 'conceptKey',
  'distanceMeters', 'hasNight', 'expectsNight', 'dayNo', 'hours', 'visit',
  'first', 'second', 'span', 'thresholds', 'missingLcls2', 'expectedLcls2',
  'rainSource', 'rainDays', 'normalMonth', 'forecastDowngradedFrom', 'showFlagTurnedOff', 'fieldNamesChanged', 'on',
  'daysToDeparture',
]);
