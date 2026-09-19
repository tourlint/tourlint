import { DWELL_MINUTES_SEED } from '@tourlint/shared';
import { straightMeters } from '../engine/geo';
import { sameDistrict, type Impact, type ImpactCandidate } from './impact-finder';
import type { SyncedContent } from './sync-batch.job';

/**
 * 기회 알림 탐색 조건 4 ~ 6 (FR-MO-030 ④⑤⑥ · FR-MO-031).
 *
 * ```
 * 4  콘텐츠 유형이 유사한 상품
 * 5  추가 가능한 빈 시간대가 있는 상품
 * 6  추가 시 이동거리 증가가 임계치 이하인 상품
 * ```
 *
 * ## 왜 셋 다 지역으로 먼저 좁히는가
 *
 * 명세는 조건 4 ~ 6 에 지역 조건을 달지 않는다. 그런데 하루 변경 177건을 그대로 태우면
 * 서울 신규 콘텐츠가 강릉 상품에 제안된다 — 반영할 수 없는 제안이다 (FR-MO-052 가
 * 「반영 가능한 일정 구간」을 함께 내라고 한다). 조건 2 와 같은 시군구로 먼저 좁힌다.
 *
 * ## 조건 4 를 결손 유형으로 읽는 이유
 *
 * 「유형이 유사」를 문자 그대로 「그 중분류를 이미 담고 있는 상품」으로 읽으면, 실측
 * 177건이 중분류 35개에 흩어져 있어 중분류 6개를 담은 상품 하나가 **하루 115건**에
 * 걸린다. 알림이 아니라 소음이다.
 *
 * FR-MO-051 이 「T1 · T2 에서 포착된 콘텐츠 중 **R10 이 지적한 결손 유형과 일치하는 것을
 * 우선 제안**」하라고 한다. 그 결손 유형으로 좁힌다 — 상품에 없는 유형이 새로 생겼을 때만
 * 알린다. 넣을 만한 것이 생겼다는 뜻이라 사용자가 할 일이 있다.
 *
 * ## 예측하지 않는다
 *
 * 조건 6 은 **직선 우회거리**로 거른다. 지어낸 이동시간으로 판정하지 않기 위해서다 —
 * 여기서 하는 일은 판정이 아니라 「볼 만한가」를 거르는 것이고, 실제 이동시간은 제안
 * 단계에서 R08 이 다시 본다 (FR-MO-052). 알림 본문에 거리를 적지 않는다.
 *
 * 순수 함수다. 후보를 모으는 일만 저장소가 한다.
 */

/** 조건 6 임계치 (m). 명세가 값을 정하지 않아 여기서 정한다 — 하루 일정에서 5km 우회는 큰 변경이다 */
export const MAX_DETOUR_METERS = 5000;

/**
 * 배치 한 번에 상품 하나가 받는 기회 알림 상한 (#616).
 *
 * 밀린 날짜를 한 번에 따라잡는 배치는 새로 등록된 곳 수십 곳을 한꺼번에 본다. 조건 5 · 6 은
 * 빈 시간대가 있는 상품이면 대부분 걸려서, 상한이 없으면 새 소식 탭이 같은 문장으로 찬다.
 * 조건 4(결손 유형)를 먼저 채운다 — FR-MO-051 이 우선 제안하라고 한 것이다.
 */
export const OPPORTUNITY_CAP_PER_PRODUCT = 3;

/**
 * 새로 등록된 곳인가 (FR-MO-030 ④ 「새로 등록된」).
 *
 * 동기화 목록에는 고쳐진 곳과 새로 생긴 곳이 섞여 온다. 기회 알림은 새로 생긴 곳만 본다 —
 * 오래된 관광지의 설명 한 줄이 바뀌었다고 「넣을 만한 곳이 생겼다」고 하지 않는다. 이번 배치가
 * 보는 첫 날짜(`since`) 이후에 등록된 곳이다. 비표출은 넣을 수 없어 뺀다.
 */
export function isNewlyRegistered(content: SyncedContent, since: string): boolean {
  if (content.showFlag !== '1') return false;
  const created = content.createdTime.slice(0, 8);
  return /^\d{8}$/.test(created) && created >= since.replace(/-/g, '');
}

/** 그 중분류의 기본 체류시간 (FR-IN-011). 표에 없으면 모른다 — 빈 시간대에 들어가는지 말할 수 없다 */
export function dwellOf(lclsSystm2: string | null): number | null {
  return lclsSystm2 === null ? null : (DWELL_MINUTES_SEED[lclsSystm2] ?? null);
}

/** 상품별로 줄 세울 기회 알림 한 건 */
export interface RankedOpportunity {
  readonly productId: number;
  readonly condition: 4 | 5 | 6;
  readonly contentId: string;
}

/**
 * 상품마다 기회 알림을 상한까지만 남긴다.
 *
 * 조건 번호가 작을수록 먼저(4 결손 유형 → 5 빈 시간대 → 6 동선), 같은 조건이면 콘텐츠 번호
 * 순이다. 같은 입력이면 늘 같은 것이 남는다 (NF-MT-001).
 */
export function capOpportunities<T extends RankedOpportunity>(
  items: readonly T[],
  cap: number = OPPORTUNITY_CAP_PER_PRODUCT,
): { kept: readonly T[]; dropped: number } {
  const sorted = [...items].sort((a, b) =>
    a.productId - b.productId || a.condition - b.condition || a.contentId.localeCompare(b.contentId));
  const count = new Map<number, number>();
  const kept: T[] = [];
  for (const item of sorted) {
    const n = count.get(item.productId) ?? 0;
    if (n >= cap) continue;
    count.set(item.productId, n + 1);
    kept.push(item);
  }
  return { kept, dropped: items.length - kept.length };
}

/** 일정 항목 하나. 조건 5 · 6 이 보는 것만 담는다 */
export interface OpportunityItem {
  readonly dayNo: number;
  readonly seq: number;
  /** `HH:MM` */
  readonly startTime: string;
  /** 종료시간을 모르면 그 앞뒤 간격은 판정하지 않는다 */
  readonly endTime: string | null;
  readonly mapX: number | null;
  readonly mapY: number | null;
}

/** 조건 4 ~ 6 후보. 조건 1 ~ 3 보다 상품 속을 더 봐야 한다 */
export interface OpportunityCandidate extends ImpactCandidate {
  /** R10 이 지적한 결손 중분류 (FR-MO-051). 러너가 채운다 */
  readonly missingLcls2: readonly string[];
  /** 확정된 일정 항목. 일차 · 순서대로 정렬돼 있다 */
  readonly items: readonly OpportunityItem[];
}

/** 조건 5 가 찾은 빈 시간대 */
export interface FreeSlot {
  readonly dayNo: number;
  /** 이 간격 앞뒤 항목. 마지막 항목 뒤는 `after` 가 null 이다 */
  readonly before: OpportunityItem;
  readonly after: OpportunityItem | null;
  readonly minutes: number;
}

/**
 * 조건 4 — 그 상품에 없는 유형이 새로 생겼다 (FR-MO-030 ④ · FR-MO-051).
 *
 * 중분류를 모르는 콘텐츠는 걸지 않는다. 「유형을 모른다」를 「결손을 채운다」로 읽을 수 없다.
 */
export function matchByMissingType(
  content: SyncedContent,
  candidates: readonly OpportunityCandidate[],
): readonly Impact[] {
  if (content.lclsSystm2 === null) return [];
  return candidates
    .filter((c) => sameRegion(c, content))
    .filter((c) => c.missingLcls2.includes(content.lclsSystm2 as string))
    .map((c) => ({ productId: c.productId, condition: 4 as const, kind: 'OPPORTUNITY' as const }));
}

/**
 * 조건 5 — 그 콘텐츠를 넣을 빈 시간대가 있다 (FR-MO-030 ⑤).
 *
 * `dwellMinutes` 는 그 중분류의 기본 체류시간이다 (FR-IN-011). 모르면 판정하지 않는다 —
 * 얼마나 걸리는지 모르는 것을 「들어간다」고 할 수 없다.
 */
export function matchByFreeSlot(
  content: SyncedContent,
  candidates: readonly OpportunityCandidate[],
  dwellMinutes: number | null,
): readonly Impact[] {
  if (dwellMinutes === null || dwellMinutes <= 0) return [];
  return candidates
    .filter((c) => sameRegion(c, content))
    .filter((c) => freeSlots(c.items, dwellMinutes).length > 0)
    .map((c) => ({ productId: c.productId, condition: 5 as const, kind: 'OPPORTUNITY' as const }));
}

/**
 * 조건 6 — 넣어도 우회가 크지 않다 (FR-MO-030 ⑥).
 *
 * ⚠️ **직선거리다.** 실제 이동시간이 아니라 「볼 만한가」를 거르는 값이며, 제안 단계에서
 *    R08 이 다시 본다 (FR-MO-052). 이 값을 알림에 적지 않는다.
 */
export function matchByDetour(
  content: SyncedContent,
  candidates: readonly OpportunityCandidate[],
  dwellMinutes: number | null,
  maxDetour: number = MAX_DETOUR_METERS,
): readonly Impact[] {
  if (content.mapX === null || content.mapY === null) return [];
  if (dwellMinutes === null || dwellMinutes <= 0) return [];
  const via = { x: content.mapX, y: content.mapY };

  return candidates
    .filter((c) => sameRegion(c, content))
    .filter((c) => freeSlots(c.items, dwellMinutes)
      .some((slot) => {
        const extra = detourMeters(slot.before, slot.after, via);
        return extra !== null && extra <= maxDetour;
      }))
    .map((c) => ({ productId: c.productId, condition: 6 as const, kind: 'OPPORTUNITY' as const }));
}

/**
 * 하루 안에서 `minMinutes` 이상 비어 있는 구간.
 *
 * **종료시간을 모르는 항목의 뒤는 세지 않는다.** 언제 끝나는지 모르면 그 뒤가 비었는지도
 * 모른다 — 비었다고 치면 이미 꽉 찬 일정에 제안이 들어간다.
 *
 * 마지막 항목 뒤도 본다. 하루의 끝은 `dayEndsAt` 으로 자른다.
 */
export function freeSlots(
  items: readonly OpportunityItem[],
  minMinutes: number,
  dayEndsAt = '21:00',
): readonly FreeSlot[] {
  const out: FreeSlot[] = [];
  const byDay = new Map<number, OpportunityItem[]>();
  for (const item of items) {
    const list = byDay.get(item.dayNo) ?? [];
    list.push(item);
    byDay.set(item.dayNo, list);
  }

  for (const [dayNo, day] of [...byDay.entries()].sort(([a], [b]) => a - b)) {
    const sorted = [...day].sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < sorted.length; i++) {
      const before = sorted[i];
      if (before === undefined) continue;
      const end = minutesOf(before.endTime);
      if (end === null) continue;

      const after = sorted[i + 1] ?? null;
      const nextStart = minutesOf(after === null ? dayEndsAt : after.startTime);
      if (nextStart === null) continue;

      const minutes = nextStart - end;
      if (minutes >= minMinutes) out.push({ dayNo, before, after, minutes });
    }
  }
  return out;
}

/**
 * 사이에 끼워 넣었을 때 늘어나는 직선거리 (m).
 *
 * 좌표를 모르면 `null` 이다 — 0 으로 치면 「우회가 전혀 없다」가 되어 아무 데나 걸린다.
 * 마지막 항목 뒤(`to` 가 null)는 왕복으로 본다.
 */
export function detourMeters(
  from: OpportunityItem,
  to: OpportunityItem | null,
  via: { x: number; y: number },
): number | null {
  if (from.mapX === null || from.mapY === null) return null;
  const a = { x: from.mapX, y: from.mapY };
  if (to === null) return Math.round(straightMeters(a, via) * 2);
  if (to.mapX === null || to.mapY === null) return null;
  const b = { x: to.mapX, y: to.mapY };
  return Math.round(straightMeters(a, via) + straightMeters(via, b) - straightMeters(a, b));
}

/**
 * `HH:MM` → 자정으로부터의 분. 모양이 아니면 `null`.
 *
 * `normalize/primitives` 의 `toMinutes` 를 쓰지 않는다 — 그건 모양을 안 보고 `NaN` 을 내서,
 * 「모른다」와 「00:00」이 코드에서 구분되지 않는다.
 */
function minutesOf(time: string | null): number | null {
  if (time === null) return null;
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (m === null) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 같은 시군구인가 — 시도 코드까지 함께 본다 (`sameDistrict`) */
function sameRegion(candidate: ImpactCandidate, content: SyncedContent): boolean {
  return sameDistrict(candidate, content);
}
