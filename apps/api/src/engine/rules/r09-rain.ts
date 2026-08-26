import { RULE_CONSTANTS, type ExceptionReasonCode, type IndoorOutdoor, type Severity } from '@tourlint/shared';
import { toMinutes } from '../normalize/primitives';
import type { IsoDate } from '../calendar/dates';
import { confirmedItems } from './types';
import type { AuditItem, AuditRule, Finding, ItineraryContext } from './types';

/**
 * R09 — 우천 리스크 (FR-RU-090 ~ 093).
 *
 * 야외 위주로 짠 하루에 비가 오면 일정이 통째로 무너진다. 현장에서 알게 되는 것이 아니라
 * 미리 볼 수 있는 것이라 주의 등급으로 알린다.
 *
 * 판정 단위는 **여행 일자**다. 출발일이 아니다 — 출발 D+2 인 2박 3일 상품의 3일차는
 * D+4 라서 근거가 중기예보로 바뀐다 (FR-RU-091).
 *
 * 조건은 둘이다 — 야외 비중과 강수 지표. **「우천 대체 일정 유무」는 조건이 아니다**
 * (FR-RU-093 v2.0, 2026.08.26 개정). 그걸 필드로 받으면 관측이 아니라 자기신고가 되고,
 * 사용자가 「있음」에 체크하면 그 일정이 실제로 실내인지 검증하지 못한 채 R09 가 침묵한다 —
 * 검수 결과를 끄는 입력이 된다. 대신 그 날 실내 항목 수를 `evidence.indoorCount` 로 남긴다.
 *
 * 강수 근거는 러너가 미리 조회해 넘긴다. 규칙은 외부를 부르지 않는다 (NF-PF-014).
 */

export const R09_VERSION = '1.0.0';

export const KMA_SOURCE = '기상청';

/** 강수 판정 근거 종류. 화면에 그대로 표기해야 한다 (FR-RU-092) */
export type RainSource = 'SHORT' | 'MID' | 'CLIMATE';

/**
 * 하루치 강수 판정 근거. 러너가 여행 일자별로 채운다.
 *
 * 단기는 **시간대별 값을 그대로** 넘긴다. 야외 일정 시간대를 예보가 덮는지 규칙이
 * 확인해야 하는데(FR-RU-091), 그 판단에 실내 · 야외 구분이 필요해서다. 러너가 미리
 * 하나로 줄이면 그 구분이 두 곳에 흩어진다.
 */
export type DailyRainOutlook =
  | {
      readonly ok: true;
      readonly source: 'SHORT';
      /** `HHmm` → 강수확률 0~1. 간격은 날짜마다 다르다 — 가까운 날은 1시간, 먼 날은 3시간 */
      readonly slots: ReadonlyMap<string, number>;
    }
  | { readonly ok: true; readonly source: 'MID'; readonly probability: number }
  | {
      readonly ok: true;
      readonly source: 'CLIMATE';
      readonly probability: number;
      readonly rainDays: number;
      readonly regionName: string;
      readonly month: number;
    }
  | { readonly ok: false; readonly reasonCode: ExceptionReasonCode };

/** 예보 간격을 잴 수 없을 때 쓰는 값(분). 좁은 쪽으로 잡는다 — 넓게 잡으면 없는 커버리지를 있다고 한다 */
const FALLBACK_SLOT_SPACING = 60;

/**
 * 야외 비중 = (야외 + 혼재 × 0.5) ÷ 전체 (FR-RU-090).
 *
 * **분모는 중분류가 매핑된 항목 수다.** 매핑이 없는 항목은 실내인지 야외인지 말할 근거가
 * 없어 양쪽 어디에도 넣지 않는다. 분모에 넣으면 「모르는 것」이 실내처럼 취급돼 비중이
 * 낮아지고, 분자에 넣으면 그 반대다.
 *
 * 숙박은 **뺀 것이 아니라 들어간다.** 실내 · 야외 매핑표에 `AC*` 가 있고(FR-RU-090
 * 기본 59행), 체류시간 표가 숙박을 뺀 것(FR-AU-011)과는 다른 이유다 — 그쪽은 종료시간을
 * 지어내지 않으려는 것이고 이쪽은 그 날 실내에 있는 시간을 세는 것이다.
 */
export function outdoorRatio(
  items: readonly AuditItem[],
  mapping: Readonly<Record<string, IndoorOutdoor>>,
): { ratio: number; mapped: number; unmapped: number; indoor: number } | null {
  let outdoor = 0;
  let mixed = 0;
  let indoor = 0;
  let unmapped = 0;

  for (const item of items) {
    const kind = item.lclsSystm2 === null ? undefined : mapping[item.lclsSystm2];
    if (kind === undefined) { unmapped++; continue; }
    if (kind === 'OUTDOOR') outdoor++;
    else if (kind === 'MIXED') mixed++;
    else indoor++;
  }

  const mapped = outdoor + mixed + indoor;
  if (mapped === 0) return null;
  return {
    ratio: (outdoor + mixed * RULE_CONSTANTS.R09_MIXED_WEIGHT) / mapped,
    mapped,
    unmapped,
    indoor,
  };
}

/** 그 날 야외에 있는 항목. 혼재도 야외로 본다 — 비를 맞는 시간이 있다 */
export function outdoorItems(
  items: readonly AuditItem[],
  mapping: Readonly<Record<string, IndoorOutdoor>>,
): readonly AuditItem[] {
  return items.filter((i) => {
    const kind = i.lclsSystm2 === null ? undefined : mapping[i.lclsSystm2];
    return kind === 'OUTDOOR' || kind === 'MIXED';
  });
}

/**
 * 야외 일정 시간대를 덮는 예보 값 중 가장 큰 것. 하나도 못 덮으면 `null` (FR-RU-091).
 *
 * 예보 한 칸은 **그 시각부터 다음 칸까지**를 뜻한다. 간격이 날짜마다 달라서
 * (2026.08.26 실측 — 당일은 1시간, D+3 은 3시간) 칸 사이 최소 간격을 재서 쓴다.
 *
 * 겹치는지만 본다. 09:00 칸이 3시간짜리면 10~11시 일정도 그 칸이 덮는다.
 */
export function coveringMax(
  slots: ReadonlyMap<string, number>,
  items: readonly AuditItem[],
): number | null {
  const spacing = slotSpacing(slots);
  let best: number | null = null;

  for (const item of items) {
    const from = toMinutes(item.startTime);
    // 종료시간이 없으면 시작 시각 한 점만 본다. 지어낸 구간으로 커버리지를 넓히지 않는다
    const to = item.endTime === null ? from : toMinutes(item.endTime);

    for (const [time, value] of slots) {
      const slotFrom = toSlotMinutes(time);
      if (slotFrom === null) continue;
      // [slotFrom, slotFrom + spacing) 과 [from, to] 가 겹치는가
      if (slotFrom <= to && slotFrom + spacing > from) {
        best = best === null ? value : Math.max(best, value);
      }
    }
  }
  return best;
}

export class R09RainRiskRule implements AuditRule {
  readonly code = 'R09';
  readonly version = R09_VERSION;
  readonly defaultSeverity: Severity = 'WARNING';
  /** 외부 산출값을 쓰므로 "외부 참고" 배지가 붙는다 (EI-CM-008) */
  readonly requiresExternal = true;

  evaluate(ctx: ItineraryContext): readonly Finding[] {
    const outlooks = ctx.rainOutlooks;
    if (outlooks === undefined) return [];

    const mapping = ctx.settings.r09IndoorOutdoor;
    const out: Finding[] = [];

    for (const [date, items] of byDate(confirmedItems(ctx.items))) {
      const outlook = outlooks.get(date);
      if (outlook === undefined) continue;

      const ratio = outdoorRatio(items, mapping);
      if (ratio === null) {
        // 중분류가 하나도 안 붙은 날은 야외 비중을 셀 수 없다
        out.push(unverified(date, 'PLACE_UNRESOLVED', '실내 · 야외를 판별할 분류가 없습니다'));
        continue;
      }

      if (!outlook.ok) {
        out.push(unverified(date, outlook.reasonCode, '강수 정보를 조회하지 못했습니다'));
        continue;
      }

      const probability = probabilityFor(outlook, items, mapping);
      if (probability === null) {
        // D+3 은 예보가 하루의 일부만 덮는다. 안 덮인 시간대를 0% 로 읽지 않는다 (FR-RU-091)
        out.push(unverified(date, 'FORECAST_UNAVAILABLE', '야외 일정 시간대를 덮는 예보가 없습니다'));
        continue;
      }

      const threshold = outlook.source === 'CLIMATE'
        ? RULE_CONSTANTS.R09_CLIMATE_RAIN_THRESHOLD
        : RULE_CONSTANTS.R09_FORECAST_RAIN_THRESHOLD;

      if (ratio.ratio < RULE_CONSTANTS.R09_OUTDOOR_RATIO_THRESHOLD) continue;
      if (probability < threshold) continue;

      out.push({
        ruleCode: 'R09',
        ruleVersion: R09_VERSION,
        severity: 'WARNING',
        reasonCode: 'RAIN_RISK',
        // 일차 단위 판정이라 지목할 항목이 없다
        targetItemId: null,
        message:
          `${date} 일정은 야외 비중이 ${percent(ratio.ratio)}입니다. ` +
          `${basisText(outlook, probability)} 우천 시 정상 운영이 어렵습니다.`,
        evidence: {
          date,
          outdoorRatio: round3(ratio.ratio),
          outdoorRatioThreshold: RULE_CONSTANTS.R09_OUTDOOR_RATIO_THRESHOLD,
          mappedCount: ratio.mapped,
          unmappedCount: ratio.unmapped,
          indoorCount: ratio.indoor,
          rainProbability: round3(probability),
          rainThreshold: threshold,
          rainSource: outlook.source,
          ...(outlook.source === 'CLIMATE' ? { rainDays: outlook.rainDays, normalMonth: outlook.month } : {}),
        },
        requiresExternal: true,
        externalSource: KMA_SOURCE,
        needsConfirmation: false,
      });
    }

    return out;
  }
}

/** 근거 종류에 맞는 강수 지표. 단기는 야외 시간대를 덮는 값만 쓴다 */
function probabilityFor(
  outlook: Extract<DailyRainOutlook, { ok: true }>,
  items: readonly AuditItem[],
  mapping: Readonly<Record<string, IndoorOutdoor>>,
): number | null {
  if (outlook.source !== 'SHORT') return outlook.probability;
  const outdoors = outdoorItems(items, mapping);
  // 야외 항목이 없으면 애초에 비중 임계를 넘지 못한다. 그래도 전체로 재서 값은 남긴다
  return coveringMax(outlook.slots, outdoors.length === 0 ? items : outdoors);
}

/** 판정 근거 종류를 화면 문장에 넣는다 (FR-RU-092) */
function basisText(outlook: Extract<DailyRainOutlook, { ok: true }>, probability: number): string {
  if (outlook.source === 'SHORT') return `단기예보 기준 — 강수확률 ${percent(probability)}.`;
  if (outlook.source === 'MID') return `중기예보 기준 — 강수확률 ${percent(probability)}.`;
  return `평년 기준 — ${outlook.month}월 ${outlook.regionName} 강수일수 ${outlook.rainDays.toFixed(1)}일 (${percent(probability)}).`;
}

function unverified(date: IsoDate, reasonCode: ExceptionReasonCode, detail: string): Finding {
  return {
    ruleCode: 'R09',
    ruleVersion: R09_VERSION,
    severity: 'UNVERIFIED',
    reasonCode,
    targetItemId: null,
    message: `${date} 우천 리스크를 판정하지 못했습니다 — ${detail}. 직접 확인해 주세요.`,
    evidence: { unverified: true, exceptionReasonCode: reasonCode, unit: 'RULE', date },
    requiresExternal: true,
    externalSource: KMA_SOURCE,
    needsConfirmation: true,
  };
}

/**
 * 여행 일자별로 묶는다. 날짜 순서를 고정해야 finding 순서가 결정론적이다 (NF-MT-001).
 *
 * 판정 대상이 하나도 없는 날짜는 키 자체가 생기지 않아 그 날은 조용히 넘어간다.
 */
function byDate(items: readonly AuditItem[]): readonly (readonly [IsoDate, readonly AuditItem[]])[] {
  const buckets = new Map<IsoDate, AuditItem[]>();
  for (const item of items) {
    const bucket = buckets.get(item.date);
    if (bucket === undefined) buckets.set(item.date, [item]);
    else bucket.push(item);
  }
  return [...buckets.entries()]
    .map(([date, list]) => [date, [...list].sort((a, b) => a.seq - b.seq || a.id - b.id)] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
}

/** 칸 사이 최소 간격(분). 잴 수 없으면 좁게 잡는다 */
function slotSpacing(slots: ReadonlyMap<string, number>): number {
  const times = [...slots.keys()]
    .map(toSlotMinutes)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  if (times.length < 2) return FALLBACK_SLOT_SPACING;

  let min = Number.POSITIVE_INFINITY;
  for (let i = 1; i < times.length; i++) min = Math.min(min, (times[i] as number) - (times[i - 1] as number));
  return min > 0 && Number.isFinite(min) ? min : FALLBACK_SLOT_SPACING;
}

/** `HHmm` → 분 */
function toSlotMinutes(hhmm: string): number | null {
  if (!/^\d{4}$/.test(hhmm)) return null;
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2, 4));
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
