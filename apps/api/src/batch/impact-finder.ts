import { addDays, formatIsoDate, parseIsoDate, type IsoDate } from '../engine/calendar/dates';
import type { SyncedContent } from './sync-batch.job';

/**
 * 변경이 어느 상품에 닿는지 찾는다 (F13 · FR-MO-030 ~ 032).
 *
 * 탐색 조건 6종 중 **위험 알림 셋(1 ~ 3)** 을 여기서 판정한다. 기회 알림(4 ~ 6)은
 * 빈 시간대 탐색과 이동거리 계산이 필요해 T1 · T2 수요 신호와 함께 붙인다.
 *
 * ```
 * 1  해당 contentid 를 일정에 포함한 상품
 * 2  동일 시군구 + 여행일이 감지일 ±7일 이내
 * 3  행사기간과 여행일이 겹치는 상품
 * ```
 *
 * **판정 자체는 순수 함수다.** 후보를 모으는 일만 저장소가 한다 — 어느 조건에 걸렸는지가
 * 알림 문구와 분류를 정하므로 재현 가능해야 한다.
 */

/** 알림 분류 (FR-MO-031). 조건 1–3 은 위험, 4–6 은 기회다 */
export type NotificationKind = 'RISK' | 'OPPORTUNITY';

/** 탐색 조건 번호. DB `ck_notif_condition` 이 1~6 만 받는다 */
export type MatchCondition = 1 | 2 | 3 | 4 | 5 | 6;

export function kindOf(condition: MatchCondition): NotificationKind {
  return condition <= 3 ? 'RISK' : 'OPPORTUNITY';
}

/**
 * 조건 2 의 날짜 창 (FR-MO-032).
 *
 * 시군구가 같다는 것만으로 알리면 그 지역 상품 전부에 알림이 간다. 여행일이 가까운
 * 것으로 좁힌다 — 두 달 뒤 출발 상품에 오늘의 변경을 알려도 할 수 있는 게 없다.
 */
export const NEARBY_DAYS = 7;

export interface ImpactCandidate {
  readonly productId: number;
  readonly startDate: IsoDate;
  readonly nights: number;
  readonly ldongSignguCd: string | null;
}

/** 행사 개최 기간. 한쪽이라도 모르면 조건 3 은 판정하지 않는다 */
export interface EventPeriod {
  readonly start: IsoDate | null;
  readonly end: IsoDate | null;
}

/**
 * 변경된 콘텐츠 하나에 붙는 부가 정보.
 *
 * 시군구는 `SyncedContent` 에 있다 — 동기화 목록이 이미 준다. 여기 남는 것은 상세
 * 재호출이 있어야 아는 것뿐이다.
 */
export interface ChangedContent extends SyncedContent {
  /** 행사(15) 개최 기간. 그 밖의 유형은 null */
  readonly eventPeriod: EventPeriod | null;
  /** 직전 지문 → 지금 지문. 같은 변경을 두 번 알리지 않는 근거다 (FR-MO-036) */
  readonly hashFrom: string | null;
  readonly hashTo: string | null;
}

export interface Impact {
  readonly productId: number;
  readonly condition: MatchCondition;
  readonly kind: NotificationKind;
}

/** 그 상품의 여행 일자 전부 (출발일 ~ 출발일 + 박수) */
export function travelDatesOf(candidate: ImpactCandidate): readonly IsoDate[] {
  const start = parseIsoDate(candidate.startDate);
  if (start === null) return [];
  return Array.from({ length: candidate.nights + 1 }, (_, i) => formatIsoDate(addDays(start, i)));
}

/**
 * 조건 1 — 그 콘텐츠를 일정에 넣은 상품.
 *
 * 가장 직접적인 영향이라 **다른 조건과 겹치면 이것이 이긴다.** 같은 상품에 조건 1 과 2 를
 * 모두 알리면 같은 변경을 두 번 말하는 셈이다.
 */
export function matchByContent(candidates: readonly ImpactCandidate[]): readonly Impact[] {
  return candidates.map((c) => ({ productId: c.productId, condition: 1 as const, kind: 'RISK' as const }));
}

/** 조건 2 — 같은 시군구 + 여행일이 감지일 ±7일 이내 (FR-MO-032) */
export function matchByRegion(
  content: ChangedContent,
  candidates: readonly ImpactCandidate[],
  detectedOn: IsoDate,
): readonly Impact[] {
  if (content.ldongSignguCd === null) return [];
  const detected = parseIsoDate(detectedOn);
  if (detected === null) return [];
  const from = formatIsoDate(addDays(detected, -NEARBY_DAYS));
  const to = formatIsoDate(addDays(detected, NEARBY_DAYS));

  return candidates
    .filter((c) => c.ldongSignguCd === content.ldongSignguCd)
    .filter((c) => travelDatesOf(c).some((d) => d >= from && d <= to))
    .map((c) => ({ productId: c.productId, condition: 2 as const, kind: 'RISK' as const }));
}

/**
 * 조건 3 — 행사기간과 여행일이 겹치는 상품.
 *
 * 행사가 아니거나 기간을 모르면 판정하지 않는다. **기간 결측을 「안 겹친다」로 읽지
 * 않는다** — 모르는 것을 근거로 알리지 않을 뿐, 겹치지 않는다고 말하지도 않는다
 * (FR-RU-023 과 같은 취지).
 */
export function matchByEventPeriod(
  content: ChangedContent,
  candidates: readonly ImpactCandidate[],
): readonly Impact[] {
  const period = content.eventPeriod;
  if (period === null || period.start === null || period.end === null) return [];

  return candidates
    .filter((c) => travelDatesOf(c).some((d) => d >= period.start! && d <= period.end!))
    .map((c) => ({ productId: c.productId, condition: 3 as const, kind: 'RISK' as const }));
}

/**
 * 조건별 결과를 합치고 **상품당 하나만 남긴다.**
 *
 * 번호가 작을수록 직접적이다. 같은 상품이 조건 1 과 2 에 다 걸리면 조건 1 로 알린다 —
 * 두 번 알리면 사용자는 문제가 둘인 줄 안다.
 */
export function mergeImpacts(...groups: readonly (readonly Impact[])[]): readonly Impact[] {
  const best = new Map<number, Impact>();
  for (const impact of groups.flat()) {
    const found = best.get(impact.productId);
    if (found === undefined || impact.condition < found.condition) best.set(impact.productId, impact);
  }
  // 상품 id 순으로 고정한다. 순서가 흔들리면 같은 배치가 다른 결과처럼 보인다
  return [...best.values()].sort((a, b) => a.productId - b.productId);
}
