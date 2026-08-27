import { addDays, formatIsoDate, parseIsoDate, type IsoDate } from '../../engine/calendar/dates';

/**
 * 발표분 고르기 (EI-WX-003 · EI-WX-008).
 *
 * 기상청은 발표분 단위로 예보를 낸다. **어느 발표분을 고르느냐가 판정을 바꾼다** —
 * 같은 날짜의 강수확률이 발표분마다 다르고, 심지어 발표분마다 덮는 날짜 범위가 다르다.
 *
 * **순수 함수다.** 시계는 인자로 받는다 (NF-MT-001).
 *
 * ⚠️ 모든 시각 계산은 **한국 시간 기준**이다. 배포 환경(Railway)이 UTC 라서 서버 시계를
 *    그대로 쓰면 오후 9시 이후 호출이 하루 전 발표분을 고른다.
 */

const KST_OFFSET_MINUTES = 9 * 60;

// ── 단기예보 ──────────────────────────────────────────────────────────

/** 단기예보 발표 시각 8회 (02 · 05 · 08 · 11 · 14 · 17 · 20 · 23시) */
export const SHORT_BASE_TIMES = ['0200', '0500', '0800', '1100', '1400', '1700', '2000', '2300'] as const;

/**
 * 발표 후 이 시간이 지나야 조회한다.
 *
 * 기상청 문서는 발표 + 10분이라 하고 2026.08.26 17:22 에 1700 발표분이 실제로 조회됐다.
 * 그래도 여유를 두는 것은 **못 받는 쪽이 잘못 받는 쪽보다 안전**해서다 — 발표 전 조회는
 * 단기에서는 `NO_DATA` 로 떨어지지만 중기에서는 이전 발표분이 조용히 온다 (EI-WX-008).
 */
export const PUBLISH_MARGIN_MINUTES = 45;

export interface ShortPublication {
  /** `YYYYMMDD` */
  readonly baseDate: string;
  /** `HHmm` */
  readonly baseTime: string;
}

/**
 * 지금 조회할 수 있는 가장 최신 단기 발표분.
 *
 * 2026.08.26 실측에서는 어제 2300 부터 오늘 1400 까지 **어느 발표분을 써도 예보 종료
 * 시점이 같았다**(D+3 21시). 최신을 고르는 이유는 커버리지가 아니라 값의 신선도다.
 */
export function chooseShortPublication(now: Date): ShortPublication {
  const kst = toKstParts(now);
  const cutoff = kst.minutesOfDay - PUBLISH_MARGIN_MINUTES;

  for (let i = SHORT_BASE_TIMES.length - 1; i >= 0; i--) {
    const slot = SHORT_BASE_TIMES[i] as string;
    if (toMinutesOfDay(slot) <= cutoff) return { baseDate: compact(kst.date), baseTime: slot };
  }
  // 02:45 이전 — 어제 마지막 발표분으로 넘어간다
  return { baseDate: compact(shiftDate(kst.date, -1)), baseTime: '2300' };
}

// ── 중기육상예보 ──────────────────────────────────────────────────────

/**
 * 발표 시각별로 덮는 오프셋(발표일로부터의 일수)이 다르다 — 2026.08.26 실측.
 *
 *   06시 발표  `rnSt4Am` ~ `rnSt10`   +4 ~ +10
 *   18시 발표  `rnSt5Am` ~ `rnSt10`   +5 ~ +10
 *
 * 명세 v1.3 은 둘 다 +5 부터라고 적었는데 18시 발표만 본 것이었다 (이슈 #92).
 */
export const MID_OFFSET_RANGE: Readonly<Record<6 | 18, { readonly from: number; readonly to: number }>> = {
  6: { from: 4, to: 10 },
  18: { from: 5, to: 10 },
};

export interface MidPublication {
  /** `YYYYMMDDHHmm` */
  readonly tmFc: string;
  /** 발표일 */
  readonly baseDate: IsoDate;
  readonly hour: 6 | 18;
}

/**
 * `earliestTarget` 을 덮는 발표분 중 가장 최신인 것. 못 덮으면 `null` 이다.
 *
 * **가장 이른 대상 일자로 고르면 나머지도 따라온다.** 발표분의 오프셋 범위는 끝이 항상
 * +10 이므로, 이른 쪽을 덮는 발표분은 늦은 쪽도 덮는다. 그래서 상품 하나에 호출도 하나다.
 *
 * **최신 발표분을 그냥 쓰면 안 된다** (EI-WX-003). 18시 발표는 그날의 D+4 를 잃는다 —
 * 저녁에 D+4 를 판정하려면 같은 날 06시 발표분으로 돌아가야 한다.
 *
 * 후보에 어제 06시를 넣지 않는다. 2026.08.26 실측에서 `NO_DATA` 였다 — 실제로 남아 있는
 * 것은 최근 2개 발표분뿐이다.
 */
export function chooseMidPublication(now: Date, earliestTarget: IsoDate): MidPublication | null {
  const kst = toKstParts(now);
  const yesterday = shiftDate(kst.date, -1);

  const candidates: MidPublication[] = [];
  if (kst.minutesOfDay >= 18 * 60 + PUBLISH_MARGIN_MINUTES) candidates.push(publication(kst.date, 18));
  if (kst.minutesOfDay >= 6 * 60 + PUBLISH_MARGIN_MINUTES) candidates.push(publication(kst.date, 6));
  candidates.push(publication(yesterday, 18));

  for (const c of candidates) {
    const offset = daysBetween(c.baseDate, earliestTarget);
    if (offset === null) return null;
    const range = MID_OFFSET_RANGE[c.hour];
    if (offset >= range.from && offset <= range.to) return c;
  }
  return null;
}

/** 발표분 안에서 오프셋 `n` 이 가리키는 날짜 */
export function midTargetDate(publication: MidPublication, offset: number): IsoDate | null {
  const base = parseIsoDate(publication.baseDate);
  return base === null ? null : formatIsoDate(addDays(base, offset));
}

// ── 공통 ──────────────────────────────────────────────────────────────

/** `to − from` (일). 둘 중 하나라도 못 읽으면 `null` — 0 으로 뭉개지 않는다 */
export function daysBetween(from: IsoDate, to: IsoDate): number | null {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  if (a === null || b === null) return null;
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

/** 한국 시간 기준 오늘 날짜 */
export function kstToday(now: Date): IsoDate {
  return toKstParts(now).date;
}

function publication(baseDate: IsoDate, hour: 6 | 18): MidPublication {
  return { tmFc: `${compact(baseDate)}${hour === 6 ? '0600' : '1800'}`, baseDate, hour };
}

function toKstParts(now: Date): { date: IsoDate; minutesOfDay: number } {
  const shifted = new Date(now.getTime() + KST_OFFSET_MINUTES * 60_000);
  return {
    date: shifted.toISOString().slice(0, 10),
    minutesOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function shiftDate(iso: IsoDate, days: number): IsoDate {
  const d = parseIsoDate(iso);
  return d === null ? iso : formatIsoDate(addDays(d, days));
}

function compact(iso: IsoDate): string {
  return iso.replace(/-/g, '');
}

function toMinutesOfDay(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2, 4));
}
