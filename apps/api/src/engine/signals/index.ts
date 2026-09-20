import { addDays, daysInMonth, formatIsoDate, parseIsoDate, type IsoDate } from '../calendar/dates';
import { visitorRegionCode } from './fetch';
import type { KeywordHits, Signal, SignalContent, SignalWindow, TypeBreakdown, VisitorRow } from './types';

export * from './types';
export * from './fetch';

/** T1 산출 기간 기본값 (FR-RU-110 · 111 로 조정 가능) */
export const T1_DEFAULT_DAYS = 30;
/** T2 는 여행기간 앞뒤 이만큼을 함께 본다 (FR-RU-120) */
export const T2_MARGIN_DAYS = 3;

/**
 * 그 창에 **새로 등록된** 것인가 (T1 의 판정 조건).
 *
 * 건수와 목록이 같은 조건을 봐야 한다 — 「1건」 이라 해 놓고 목록에 두 줄이 뜨면 둘 다
 * 못 믿는다. 세는 쪽(`summarizeNewContents`)과 보여 주는 쪽이 이 함수 하나를 쓴다.
 */
export function isNewInWindow(c: SignalContent, window: SignalWindow): boolean {
  if (!inRegion(c, window)) return false;
  // 14자리가 아니면 비교할 수 없다. 모르는 것을 신규로 세지 않는다
  if (!/^\d{14}$/.test(c.createdTime)) return false;
  const from = `${window.from.replace(/-/g, '')}000000`;
  // 마지막 날을 통째로 포함한다. `YYYYMMDD` 뒤에 시각이 붙어 오기 때문이다
  const to = `${window.to.replace(/-/g, '')}235959`;
  return c.createdTime >= from && c.createdTime <= to;
}

/** 그 창에 **열리는** 행사인가 (T2 의 판정 조건). 기간을 모르는 행사는 세지 않는다 */
export function opensInWindow(c: SignalContent, window: SignalWindow): boolean {
  if (!inRegion(c, window)) return false;
  if (c.eventStart === null || c.eventEnd === null) return false;
  // 행사기간과 조회 구간이 하루라도 겹치면 센다
  return c.eventStart <= window.to && c.eventEnd >= window.from;
}

/**
 * T1 — 그 지역에 최근 며칠 안에 **신규 등록**된 콘텐츠 (FR-RU-110).
 *
 * 근거 필드는 `createdtime` 과 `contentTypeId` 다. 수정된 것이 아니라 새로 올라온 것만
 * 센다 — `modifiedtime` 을 쓰면 오래된 콘텐츠의 사진 교체가 신규로 잡힌다.
 *
 * 관심 키워드는 **건수를 거르지 않고** 키워드별 곳 목록(`byKeyword`)으로 따로 둔다
 * (FR-RU-112). 같은 창을 여러 계정이 나눠 쓰므로, 거른 건수를 저장하면 키워드가 없는
 * 계정의 T1 까지 줄어든다. 계정별로 거르는 것은 조회다.
 */
export function summarizeNewContents(
  contents: readonly SignalContent[],
  window: SignalWindow,
  keywords: readonly string[] = [],
): Signal {
  const matched = contents.filter((c) => isNewInWindow(c, window));

  return {
    count: matched.length,
    byType: countByType(matched),
    byKeyword: hitsByKeyword(matched, keywords),
    window,
  };
}

/**
 * T2 — 여행기간 ±3일(관심 지역은 그 달)에 그 지역에서 **열리는 행사** (FR-RU-120 · FR-MO-059).
 *
 * 근거 필드는 `eventstartdate` · `eventenddate` 다. 기간을 모르는 행사는 세지 않는다 —
 * 결측을 「그 기간에 열린다」로도 「안 열린다」로도 읽지 않는다. 관심 키워드는 T1 과 같이
 * 건수를 거르지 않고 곳 목록으로 둔다 — 지역 카드의 "'커피' 행사 1" (UI-S7-015).
 */
export function summarizeFestivals(
  contents: readonly SignalContent[],
  window: SignalWindow,
  keywords: readonly string[] = [],
): Signal {
  const matched = contents.filter((c) => opensInWindow(c, window));

  return { count: matched.length, byType: countByType(matched), byKeyword: hitsByKeyword(matched, keywords), window };
}

/**
 * T3 — 지난해 같은 달 그 지역 방문자 수 (FR-MO-059 · 060 · EI-KT-026).
 *
 * 창 안의 날마다 현지인 · 외지인 · 외국인(`touDivCd` 1 – 3)을 모두 더해 반올림한다. 관측된
 * 수일 뿐 인기 · 예측이 아니다. **그 지역 줄이 하나도 없으면 `null`** 이고 0 이 아니다 —
 * 지난해 코드와 이어지지 않는 지역(2026년 행정구역이 바뀐 곳)을 「방문자 0」으로 읽으면 안 된다.
 */
export function summarizeVisitors(rows: readonly VisitorRow[], window: SignalWindow): Signal | null {
  const code = visitorRegionCode(window);
  if (code === null) return null;
  const mine = rows.filter((r) =>
    r.signguCode === code && r.touNum !== null
    && r.baseYmd !== null && r.baseYmd >= window.from && r.baseYmd <= window.to);
  if (mine.length === 0) return null;
  const total = mine.reduce((sum, r) => sum + (r.touNum ?? 0), 0);
  return { count: Math.round(total), byType: {}, byKeyword: {}, window };
}

/** `YYYY-MM` 그 달 1일부터 말일까지 — 관심 지역 T2 창 (FR-MO-059). 달이 아니면 null */
export function monthWindow(
  month: string,
  region: { ldongRegnCd: string | null; ldongSignguCd: string | null },
): SignalWindow | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  const first = m === null ? null : parseIsoDate(`${m[1]}-${m[2]}-01`);
  if (first === null) return null;
  return {
    ...region,
    from: formatIsoDate(first),
    to: formatIsoDate({ ...first, day: daysInMonth(first.year, first.month) }),
  };
}

/** 지난해 같은 달 — 관심 지역 T3 창 (FR-MO-059). 2월은 그해 말일까지다 */
export function lastYearMonthWindow(
  month: string,
  region: { ldongRegnCd: string | null; ldongSignguCd: string | null },
): SignalWindow | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  return m === null ? null : monthWindow(`${Number(m[1]) - 1}-${m[2]}`, region);
}

/**
 * T1 조회 구간 — 오늘로부터 `days` 일 전까지 (FR-RU-110 · 111).
 *
 * 기간을 화면에 그대로 적어야 해서 (FR-MO-056) 계산을 여기 모아 둔다.
 */
export function t1Window(
  today: IsoDate,
  region: { ldongRegnCd: string | null; ldongSignguCd: string | null },
  days: number = T1_DEFAULT_DAYS,
): SignalWindow | null {
  const end = parseIsoDate(today);
  if (end === null || !Number.isInteger(days) || days < 1) return null;
  return { ...region, from: formatIsoDate(addDays(end, -(days - 1))), to: today };
}

/** T2 조회 구간 — 여행기간 앞뒤 3일 (FR-RU-120) */
export function t2Window(
  startDate: IsoDate,
  nights: number,
  region: { ldongRegnCd: string | null; ldongSignguCd: string | null },
  margin: number = T2_MARGIN_DAYS,
): SignalWindow | null {
  const start = parseIsoDate(startDate);
  if (start === null || !Number.isInteger(nights) || nights < 0) return null;
  return {
    ...region,
    from: formatIsoDate(addDays(start, -margin)),
    to: formatIsoDate(addDays(start, nights + margin)),
  };
}

/**
 * 지역이 맞는가.
 *
 * **시군구가 창에 지정돼 있으면 시군구까지 같아야 한다.** 시도만 보면 강원 상품에
 * 삼척 신규 콘텐츠가 잡혀 「내 지역 신호」로 보인다.
 */
function inRegion(content: SignalContent, window: SignalWindow): boolean {
  if (window.ldongSignguCd !== null) return content.ldongSignguCd === window.ldongSignguCd;
  if (window.ldongRegnCd !== null) return content.ldongRegnCd === window.ldongRegnCd;
  return true;
}

/**
 * 키워드별로 창 안에서 맞는 곳. 넘겨받은 키워드는 맞는 곳이 없어도 빈 배열로 남긴다 —
 * 키가 없으면 조회가 「배치가 아직 안 본 키워드」로 읽는다.
 */
function hitsByKeyword(contents: readonly SignalContent[], keywords: readonly string[]): KeywordHits {
  // 객체 대신 Map 이다 — 키워드가 `constructor` 여도 프로토타입 값을 건드리지 않는다
  const hits = new Map<string, Set<string>>();
  for (const k of [...new Set(keywords)].filter((k) => k !== '').sort()) hits.set(k, new Set());
  for (const c of contents) {
    for (const k of c.matchedKeywords) hits.get(k)?.add(c.contentId);
  }
  return Object.fromEntries([...hits].map(([k, ids]) => [k, [...ids]]));
}

/**
 * 유형 분포. **점수를 매기지 않는다** — 건수만 센다 (FR-RU-121).
 *
 * 정렬하지 않는다. `contentTypeId` 가 정수형 문자열이라 JS 가 이미 오름차순으로 내고,
 * `UNKNOWN` 은 그 뒤에 붙는다 — 입력 순서와 무관하게 같은 결과다. `localeCompare` 로
 * 다시 정렬해 봤자 아무것도 안 바뀌고, 오히려 한 자리 코드가 생기면 `'12' < '9'` 로
 * 뒤집힌다.
 */
function countByType(contents: readonly SignalContent[]): TypeBreakdown {
  const out: Record<string, number> = {};
  for (const c of contents) {
    // 유형을 모르면 버리지 않고 UNKNOWN 으로 남긴다. 버리면 건수와 분포 합이 어긋난다
    const key = c.contentTypeId === '' ? 'UNKNOWN' : c.contentTypeId;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
