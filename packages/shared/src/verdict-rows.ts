import { CONCEPT_LABEL, TARGET_LABEL, type ConceptKey, type TargetKey } from './target-profile';
import { LCLS_SYSTM2 } from './lcls-systm';

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
