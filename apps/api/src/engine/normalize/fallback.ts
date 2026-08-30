import type { ParseConfidence } from '@tourlint/shared';
import { DAYS_OF_WEEK, HOLIDAY_RULES, type DayOfWeek, type HolidayRule,
  type HoursEntry, type NormalizedOperatingInfo, type TimeSpan,
  type UnparsedFragment } from './types';

/**
 * 사전 파서가 못 읽은 조각의 LLM 해석을 **합친다** (F03 · FR-AU-010 · DR-NM-031).
 *
 * 순수 함수다. LLM 호출도 캐시 조회도 여기서 하지 않는다 — 러너가 결과를 가져와 넘긴다.
 *
 * ## 사전 파서 영역을 침범하지 않는다
 *
 * **이미 값이 있는 축은 덮지 않는다.** 정규식이 읽어 낸 것이 정답이고 LLM 은 그것이
 * 비어 있을 때만 채운다. 덮게 두면 커버리지 95.8% 를 만든 파서를 5% 를 위해 흔드는
 * 것이고, 회귀 정답셋이 조용히 밀린다 (이슈 #43 마지막 항목).
 *
 * 이 규칙 하나로 골든 케이스가 구조적으로 안전해진다 — 정답셋은 전부 파서가 읽는
 * 케이스라 폴백이 닿지 않는다.
 *
 * ## 잘못 읽으면 잘못된 차단이 된다
 *
 * LLM 이 해석한 조각은 신뢰도가 `CONFIRMED` 다 (DR-NM-031). 휴무 요일을 잘못 읽으면
 * 곧바로 R01 차단이고, 차단은 무시할 수 없다 (PM-NG-001). 그래서 **검증이 관대하면
 * 안 된다** — 모양이 조금이라도 어긋나면 통째로 버리고 조각을 미해석으로 둔다.
 */

/** LLM 에게 요구하는 모양. 정규화 스키마의 부분집합이다 */
export const FALLBACK_SCHEMA = {
  type: 'object' as const,
  properties: {
    weeklyClosed: { type: 'array', items: { type: 'string', enum: [...DAYS_OF_WEEK] } },
    holidayRule: { type: 'array', items: { type: 'string', enum: [...HOLIDAY_RULES] } },
    fixedClosed: { type: 'array', items: { type: 'string', pattern: '^\\d{2}-\\d{2}$' } },
    openHours: {
      type: 'object',
      properties: {
        open: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
        close: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
        breaks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
              to: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
            },
            required: ['from', 'to'],
          },
        },
        admissionCutoff: { type: ['string', 'null'], pattern: '^\\d{2}:\\d{2}$' },
      },
      required: ['open', 'close'],
    },
    /** 조건부 규칙으로 분류되면 신뢰도가 `ESTIMATED` 다 (DR-NM-031) */
    conditional: { type: 'boolean' },
  },
  required: [],
  additionalProperties: false,
};

export const FALLBACK_SCHEMA_NAME = 'operating_info_fragment';

/** 검증을 통과한 LLM 해석. 통과 못 하면 아예 만들지 않는다 */
export interface FallbackParse {
  readonly weeklyClosed: readonly DayOfWeek[];
  readonly holidayRule: readonly HolidayRule[];
  readonly fixedClosed: readonly string[];
  readonly openHours: HoursEntry | null;
  /** 조건부로 분류됐는가. 참이면 신뢰도가 `ESTIMATED` (DR-NM-031) */
  readonly conditional: boolean;
}

const TIME = /^([01]\d|2[0-4]):[0-5]\d$/;
const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * LLM 응답을 검증한다. **하나라도 어긋나면 `null`** 이다.
 *
 * 부분적으로 살려 쓰지 않는다 — 모양을 못 지킨 응답의 나머지 절반을 믿을 근거가 없다.
 */
export function parseFallbackResult(value: unknown): FallbackParse | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;

  const weeklyClosed = enumArray(v.weeklyClosed, DAYS_OF_WEEK);
  const holidayRule = enumArray(v.holidayRule, HOLIDAY_RULES);
  const fixedClosed = patternArray(v.fixedClosed, MONTH_DAY);
  if (weeklyClosed === null || holidayRule === null || fixedClosed === null) return null;

  const openHours = readHours(v.openHours);
  if (openHours === undefined) return null;

  const conditional = v.conditional;
  if (conditional !== undefined && typeof conditional !== 'boolean') return null;

  // 아무것도 안 읽어 온 응답은 해석에 실패한 것으로 본다. 조각은 미해석으로 남는다
  if (weeklyClosed.length === 0 && holidayRule.length === 0
      && fixedClosed.length === 0 && openHours === null) return null;

  return { weeklyClosed, holidayRule, fixedClosed, openHours, conditional: conditional === true };
}

/**
 * 합친다. **비어 있는 축만 채우고 해석된 조각을 `unparsed` 에서 뺀다.**
 *
 * 신뢰도는 채운 경로에만 준다 — 안 채운 경로의 신뢰도를 건드리면 파서가 내린 판단이
 * 바뀐다.
 */
export function mergeFallback(
  base: NormalizedOperatingInfo,
  fragment: UnparsedFragment,
  parsed: FallbackParse,
): NormalizedOperatingInfo {
  // DR-NM-031 — LLM 해석은 CONFIRMED 이되 조건부로 분류되면 ESTIMATED
  const confidence: ParseConfidence = parsed.conditional ? 'ESTIMATED' : 'CONFIRMED';
  const byPath: Record<string, ParseConfidence> = { ...base.confidence.byPath };
  const filled: string[] = [];

  // 이미 값이 있으면 손대지 않는다. 정규식이 읽은 것이 정답이다
  const takeWeekly = base.weeklyClosed.length === 0 && parsed.weeklyClosed.length > 0;
  const takeHoliday = base.holidayRule.length === 0 && parsed.holidayRule.length > 0;
  const takeFixed = base.fixedClosed.length === 0 && parsed.fixedClosed.length > 0;
  const takeHours = base.openHours === null && parsed.openHours !== null;

  if (takeWeekly) { byPath.weeklyClosed = confidence; filled.push('weeklyClosed'); }
  if (takeHoliday) { byPath.holidayRule = confidence; filled.push('holidayRule'); }
  if (takeFixed) { byPath.fixedClosed = confidence; filled.push('fixedClosed'); }
  if (takeHours) { byPath.openHours = confidence; filled.push('openHours'); }

  // 아무 축도 못 채웠으면 조각은 여전히 미해석이다. 지우면 「해결됐다」로 읽힌다
  if (filled.length === 0) return base;

  const unparsed = base.unparsed.filter((u) => u !== fragment);
  return {
    ...base,
    weeklyClosed: takeWeekly ? parsed.weeklyClosed : base.weeklyClosed,
    holidayRule: takeHoliday ? parsed.holidayRule : base.holidayRule,
    fixedClosed: takeFixed ? parsed.fixedClosed : base.fixedClosed,
    openHours: takeHours ? parsed.openHours : base.openHours,
    // alwaysOpen 이 참인데 휴무를 채우면 스키마가 모순이다 (DR-NM 5-2)
    alwaysOpen: base.alwaysOpen && !(takeWeekly || takeHoliday || takeFixed),
    unparsed,
    confidence: { overall: lowest(byPath, unparsed.length > 0), byPath },
  };
}

/** `byPath` 의 최솟값. 미해석 조각이 남아 있으면 전체는 그보다 좋을 수 없다 */
function lowest(byPath: Readonly<Record<string, ParseConfidence>>, hasUnparsed: boolean): ParseConfidence {
  const order: ParseConfidence[] = ['UNPARSED', 'ESTIMATED', 'CONFIRMED'];
  let worst = 2;
  for (const c of Object.values(byPath)) worst = Math.min(worst, order.indexOf(c));
  if (hasUnparsed) worst = Math.min(worst, 1);
  return order[worst] ?? 'UNPARSED';
}

function enumArray<T extends string>(
  value: unknown, allowed: readonly T[],
): readonly T[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const v of value) {
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) return null;
    if (!out.includes(v as T)) out.push(v as T);
  }
  return out;
}

function patternArray(value: unknown, pattern: RegExp): readonly string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string' || !pattern.test(v)) return null;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** 통과하면 값, 없으면 `null`, 모양이 틀리면 `undefined` (호출자가 전체를 버린다) */
function readHours(value: unknown): HoursEntry | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const h = value as Record<string, unknown>;
  const open = h.open;
  const close = h.close;
  if (typeof open !== 'string' || !TIME.test(open)) return undefined;
  if (typeof close !== 'string' || !TIME.test(close)) return undefined;

  const cutoffRaw = h.admissionCutoff;
  let admissionCutoff: string | null = null;
  if (cutoffRaw !== undefined && cutoffRaw !== null) {
    if (typeof cutoffRaw !== 'string' || !TIME.test(cutoffRaw)) return undefined;
    admissionCutoff = cutoffRaw;
  }

  const breaks: TimeSpan[] = [];
  if (h.breaks !== undefined) {
    if (!Array.isArray(h.breaks)) return undefined;
    for (const b of h.breaks) {
      if (typeof b !== 'object' || b === null) return undefined;
      const span = b as Record<string, unknown>;
      if (typeof span.from !== 'string' || !TIME.test(span.from)) return undefined;
      if (typeof span.to !== 'string' || !TIME.test(span.to)) return undefined;
      breaks.push({ from: span.from, to: span.to });
    }
  }
  return { open, close, breaks, admissionCutoff };
}
