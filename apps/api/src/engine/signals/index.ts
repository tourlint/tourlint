import { addDays, formatIsoDate, parseIsoDate, type IsoDate } from '../calendar/dates';
import type { Signal, SignalContent, SignalWindow, TypeBreakdown } from './types';

export * from './types';

/** T1 산출 기간 기본값 (FR-RU-110 · 111 로 조정 가능) */
export const T1_DEFAULT_DAYS = 30;
/** T2 는 여행기간 앞뒤 이만큼을 함께 본다 (FR-RU-120) */
export const T2_MARGIN_DAYS = 3;

/**
 * T1 — 그 지역에 최근 며칠 안에 **신규 등록**된 콘텐츠 (FR-RU-110).
 *
 * 근거 필드는 `createdtime` 과 `contentTypeId` 다. 수정된 것이 아니라 새로 올라온 것만
 * 센다 — `modifiedtime` 을 쓰면 오래된 콘텐츠의 사진 교체가 신규로 잡힌다.
 *
 * 관심 키워드가 걸려 있으면 그것에 맞는 것만 센다 (FR-RU-112). 걸러낸 뒤의 건수를
 * 돌려주므로 화면이 다시 세지 않는다.
 */
export function summarizeNewContents(
  contents: readonly SignalContent[],
  window: SignalWindow,
  options: { readonly keywordFiltered?: boolean } = {},
): Signal {
  const from = `${window.from.replace(/-/g, '')}000000`;
  // 마지막 날을 통째로 포함한다. `YYYYMMDD` 뒤에 시각이 붙어 오기 때문이다
  const to = `${window.to.replace(/-/g, '')}235959`;

  const matched = contents.filter((c) => {
    if (!inRegion(c, window)) return false;
    if (options.keywordFiltered === true && !c.matchesKeyword) return false;
    // 14자리가 아니면 비교할 수 없다. 모르는 것을 신규로 세지 않는다
    if (!/^\d{14}$/.test(c.createdTime)) return false;
    return c.createdTime >= from && c.createdTime <= to;
  });

  return { count: matched.length, byType: countByType(matched), window };
}

/**
 * T2 — 여행기간 ±3일에 그 지역에서 **열리는 행사** (FR-RU-120).
 *
 * 근거 필드는 `eventstartdate` · `eventenddate` 다. 기간을 모르는 행사는 세지 않는다 —
 * 결측을 「그 기간에 열린다」로도 「안 열린다」로도 읽지 않는다.
 */
export function summarizeFestivals(
  contents: readonly SignalContent[],
  window: SignalWindow,
): Signal {
  const matched = contents.filter((c) => {
    if (!inRegion(c, window)) return false;
    if (c.eventStart === null || c.eventEnd === null) return false;
    // 행사기간과 조회 구간이 하루라도 겹치면 센다
    return c.eventStart <= window.to && c.eventEnd >= window.from;
  });

  return { count: matched.length, byType: countByType(matched), window };
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

/** 유형 분포. **점수를 매기지 않는다** — 건수만 센다 (FR-RU-121) */
function countByType(contents: readonly SignalContent[]): TypeBreakdown {
  const out: Record<string, number> = {};
  for (const c of contents) {
    const key = c.contentTypeId === '' ? 'UNKNOWN' : c.contentTypeId;
    out[key] = (out[key] ?? 0) + 1;
  }
  // 키 순서를 고정한다. 같은 입력이 다른 순서를 내면 화면이 실행마다 달라 보인다
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
