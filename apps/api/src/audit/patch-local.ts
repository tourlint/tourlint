import { SETTING_DEFAULTS, type IndoorOutdoor } from '@tourlint/shared';
import { addDays, parseIsoDate } from '../engine/calendar/dates';
import type { HolidayCalendar } from '../engine/calendar/holidays';
import { evaluateClosed } from '../engine/rules/r01-operating';
import { addMinutes } from '../engine/itinerary/dwell';
import { pointOf, straightMeters } from '../engine/geo';
import { toMinutes } from '../engine/normalize/primitives';
import type { AuditItem, Finding } from '../engine/rules/types';
import { patchId, type Patch } from './patch-types';

/**
 * 외부 호출 없이 만들 수 있는 수정안 (0콜).
 *
 * `TIME_SHIFT` · `REORDER` · `INSERT_ITEM` · `REMOVE_ITEM` 은 전부 **사용자의 일정 항목**을
 * 대상으로 한다. 공사에 물어볼 것이 없으므로 순수 함수로 만든다 (NF-MT-001).
 *
 * `REPLACE_CONTENT` 만 대체 관광지를 찾아야 해서 `patch-remote.ts` 로 따로 뺐다.
 */

export interface LocalPatchInput {
  readonly finding: Finding;
  readonly items: readonly AuditItem[];
  readonly holidays: HolidayCalendar;
  /**
   * 중분류별 실내 · 야외 구분 (FR-OP-021). R09 순서 교체가 쓴다.
   *
   * 러너가 계정 설정에서 읽어 넘긴다 — 수정안이 규칙과 다른 표를 보면 반영 후 재검수에서
   * 또 걸린다.
   */
  readonly indoorOutdoor?: Readonly<Record<string, IndoorOutdoor>>;
}

export function proposeLocalPatches(input: LocalPatchInput): readonly Patch[] {
  const { finding, items } = input;

  /*
   * **대상 항목이 없는 규칙이 먼저다.** R04 · R09 · R10 은 상품 · 일차 단위 판정이라
   * `targetItemId` 가 `null` 이다. 아래 `target` 검사에 걸려 수정안이 하나도 안 나왔다.
   */
  switch (finding.ruleCode) {
    case 'R09': return r09(finding, items, input.indoorOutdoor ?? {});
    case 'R04': return r04(finding, items);
    // R07 은 「식사가 짧다」면 그 항목을, 「아예 없다」면 아무것도 지목하지 않는다.
    // 뒤쪽 `target` 검사에 두면 **식사가 없는 쪽만** 수정안이 사라진다 — 정작 넣어 줘야 할 때다
    case 'R07': return r07(finding, items);
    default: break;
  }

  const target = items.find((i) => i.id === finding.targetItemId);
  if (target === undefined) return [];

  switch (finding.ruleCode) {
    case 'R01': return r01(finding, target, items, input.holidays);
    case 'R02': return r02(finding, target);
    case 'R03': return r03(finding, items);
    case 'R08': return r08(finding, items);
    default: return [];
  }
}

/**
 * R01 — 방문 날짜 변경 · 일정 순서 교체 (FR-RU-013 ①②).
 *
 * 셋 중 어느 것을 내는지가 사유코드에 달렸다.
 *   휴무 충돌  → 날짜를 바꾸면 풀린다. 순서 교체는 같은 날 안이라 **의미가 없다**
 *   시각 충돌  → 같은 날 다른 시간대와 바꾸면 풀릴 수 있다
 */
function r01(
  finding: Finding,
  target: AuditItem,
  items: readonly AuditItem[],
  holidays: HolidayCalendar,
): readonly Patch[] {
  const out: Patch[] = [];
  const isRestDay = finding.reasonCode === 'REST_DAY_CONFLICT' || finding.reasonCode === 'REST_DAY_UNCERTAIN';

  if (isRestDay) {
    const slot = openSlotFor(target, items, holidays);
    if (slot !== null) {
      out.push({
        patchId: patchId(out.length), type: 'TIME_SHIFT', targetItemId: target.id,
        payload: {
          newDayNo: slot.dayNo,
          newStartTime: slot.startTime,
          ...(slot.endTime === null ? {} : { newEndTime: slot.endTime }),
        },
      });
    }
  } else {
    const swap = swapCandidate(target, items);
    if (swap !== null) {
      out.push({
        patchId: patchId(out.length), type: 'REORDER', targetItemId: target.id,
        payload: { swapWithItemId: swap.id },
      });
    }
  }
  return out;
}

/**
 * 그 콘텐츠가 **열려 있고 들어갈 자리가 있는** 다른 일차를 찾는다.
 *
 * 아무 날이나 제안하면 옮긴 날도 휴무라 다시 차단이 난다. 상품 안의 다른 일차를 실제로
 * 판정해 보고 열려 있는 날만 고른다. 판정 로직은 R01 것을 그대로 쓴다 — 수정안이 규칙과
 * 다른 기준으로 날짜를 고르면 반영 후 재검수에서 또 걸린다.
 *
 * ⚠️ **날짜만 보고 시각을 그대로 들고 가지 않는다.** 옮긴 날의 그 시각에 이미 다른 항목이
 *    있으면 붙여 놓게 되고, 반영 후 재검수에서 「이동에 N분이 걸리는데 배정된 시간은
 *    0분」 오류가 난다 (R08). 실제로 그렇게 냈다 — 화요일 휴무인 식사를 2일차 12:00 으로
 *    옮겨 앞 식사(11:30~12:00)에 맞붙였다.
 *
 * 그래서 **빈 구간을 찾아 앞뒤로 여유를 두고** 놓는다. 이동시간 자체는 0콜 단계라 알 수
 * 없고, 반영 후 재검수에서 R08 이 본다 (FR-PA-020 의 자동 재검수).
 */
function openSlotFor(
  target: AuditItem,
  items: readonly AuditItem[],
  holidays: HolidayCalendar,
): { dayNo: number; startTime: string; endTime: string | null } | null {
  const normalized = target.content?.normalized ?? null;
  const base = parseIsoDate(target.date);
  if (normalized === null || base === null) return null;

  const duration = durationOf(target);
  const days = [...new Set(items.map((i) => i.dayNo))].sort((a, b) => a - b);

  for (const dayNo of days) {
    if (dayNo === target.dayNo) continue;
    const date = addDays(base, dayNo - target.dayNo);
    if (evaluateClosed(normalized, date, holidays).kind !== 'OPEN') continue;

    const placed = placeIn(items.filter((i) => i.dayNo === dayNo), duration);
    if (placed !== null) {
      return { dayNo, startTime: placed, endTime: duration === null ? null : addMinutes(placed, duration) };
    }
  }
  return null;
}

/**
 * 옮긴 자리 앞뒤에 두는 최소 여유 (분).
 *
 * 이동시간을 여기서 알 수 없다 — 알려면 카카오모빌리티를 불러야 하는데 이 단계는 0콜이다.
 * 맞붙여 놓는 것만이라도 막는다. 실제 이동시간은 반영 후 재검수에서 R08 이 본다.
 */
export const MIN_TRANSFER_MINUTES = 30;

/** 그 일차에서 `duration` 분이 여유까지 들어가는 첫 자리. 없으면 null */
function placeIn(dayItems: readonly AuditItem[], duration: number | null): string | null {
  const need = (duration ?? SETTING_DEFAULTS.dwellFallbackMinutes) + MIN_TRANSFER_MINUTES * 2;
  const sorted = [...dayItems].sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));

  let cursor = toMinutes(DAY_STARTS_AT);
  for (const next of sorted) {
    const gap = toMinutes(next.startTime) - cursor;
    if (gap >= need) return fromMinutes(cursor + MIN_TRANSFER_MINUTES);
    // 숙박은 종료시간이 없다. 체크인 시각이 그 날의 끝이라 뒤로 못 간다 (R07 `daySpan`)
    const end = next.itemType === 'LODGING' ? null : next.endTime;
    if (end === null) return null;
    cursor = Math.max(cursor, toMinutes(end));
  }

  const tail = toMinutes(DAY_ENDS_AT) - cursor;
  return tail >= need ? fromMinutes(cursor + MIN_TRANSFER_MINUTES) : null;
}

/** 하루의 양 끝. R07 의 연속 일정 판정과 같은 시간대를 본다 */
const DAY_STARTS_AT = '09:00';
const DAY_ENDS_AT = '21:00';

/** 항목의 소요시간(분). 종료시간을 모르면 null */
function durationOf(item: AuditItem): number | null {
  if (item.endTime === null) return null;
  const minutes = toMinutes(item.endTime) - toMinutes(item.startTime);
  return minutes > 0 ? minutes : null;
}

function fromMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 같은 일차 안에서 시간대를 바꿔 볼 만한 항목. 관광 항목끼리만 바꾼다 */
function swapCandidate(target: AuditItem, items: readonly AuditItem[]): AuditItem | null {
  return items.find(
    (i) => i.id !== target.id && i.dayNo === target.dayNo && i.itemType === target.itemType && i.endTime !== null,
  ) ?? null;
}

/** R02 — 해당 일정 제거 (FR-RU-022 ②). 대체 행사 교체는 외부 조회가 필요해 따로 만든다 */
function r02(finding: Finding, target: AuditItem): readonly Patch[] {
  if (finding.reasonCode !== 'EVENT_ENDED' && finding.reasonCode !== 'EVENT_NOT_STARTED') return [];
  return [{ patchId: patchId(0), type: 'REMOVE_ITEM', targetItemId: target.id, payload: {} }];
}

/**
 * R03 — 뒤 일정 시작시간 조정 · 앞 일정 소요시간 단축 (FR-RU-033).
 *
 * 겹친 두 항목을 `evidence` 에서 꺼낸다. 어느 쪽을 고칠지는 사용자가 고르게 두고
 * 양쪽을 다 제시한다.
 */
function r03(finding: Finding, items: readonly AuditItem[]): readonly Patch[] {
  const first = items.find((i) => i.id === finding.targetItemId);
  const second = items.find((i) => i.id === finding.targetItemId2);
  if (first === undefined || second === undefined || first.endTime === null || second.endTime === null) return [];

  const out: Patch[] = [];
  const shift = toMinutes(first.endTime) - toMinutes(second.startTime);
  if (shift > 0) {
    // ① 뒤 일정을 겹친 만큼 미룬다
    out.push({
      patchId: patchId(out.length), type: 'TIME_SHIFT', targetItemId: second.id,
      payload: { newStartTime: first.endTime, newEndTime: addMinutes(second.endTime, shift) },
    });
    // ② 앞 일정을 뒤 일정 시작까지로 줄인다
    out.push({
      patchId: patchId(out.length), type: 'TIME_SHIFT', targetItemId: first.id,
      payload: { newEndTime: second.startTime },
    });
  }
  return out;
}

/**
 * R04 — 반복 유형 중 한 곳을 뺀다 (FR-RU-043).
 *
 * 명세는 「다른 유형으로 교체」다. 교체할 **다른 유형**을 여기서 정할 수가 없다 — 무엇이
 * 모자란지는 R10 이 아는 것이고 R04 의 근거에는 없다. 그래서 0콜로 낼 수 있는 것은 제거뿐이고,
 * 다른 유형으로 바꾸는 쪽은 외부 조회가 필요해 `patch-remote` 가 낸다.
 *
 * **어느 하나를 뺄지는 마지막 것으로 고정한다.** 순서가 흔들리면 같은 검수가 실행마다 다른
 * 수정안을 낸다 (NF-MT-001). 앞쪽을 빼면 그 뒤가 통째로 당겨져 영향이 크다.
 */
function r04(finding: Finding, items: readonly AuditItem[]): readonly Patch[] {
  const ids = finding.evidence.itemIds;
  if (!Array.isArray(ids) || ids.length < 2) return [];

  const repeated = ids
    .map((id) => items.find((i) => i.id === Number(id)))
    .filter((i): i is AuditItem => i !== undefined)
    .sort((a, b) => (a.dayNo - b.dayNo) || (toMinutes(a.startTime) - toMinutes(b.startTime)));

  const last = repeated[repeated.length - 1];
  if (last === undefined) return [];
  return [{ patchId: patchId(0), type: 'REMOVE_ITEM', targetItemId: last.id, payload: {} }];
}

/**
 * R09 — 실내 · 야외 순서 교체 (FR-RU-093 ②).
 *
 * 그 날 야외 항목을 앞으로, 실내 항목을 뒤로 돌린다. 비는 대개 오후에 굵어지므로 실내를
 * 뒤에 두면 젖는 시간이 준다 — 일정을 빼지 않고 순서만 바꾸는 가장 가벼운 수정이다.
 *
 * ⚠️ **실내 관광지 추가(①)와 우천용 대체(③)는 여기서 못 낸다.** 무엇을 넣을지 찾아야 해서
 *    외부 조회가 필요하다 (`patch-remote`).
 *
 * 구분표를 모르는 중분류는 건드리지 않는다. 실내인지 야외인지 모르는 것을 옮기면 더
 * 나빠질 수도 있다 (FR-RU-051).
 */
function r09(
  finding: Finding,
  items: readonly AuditItem[],
  indoorOutdoor: Readonly<Record<string, IndoorOutdoor>>,
): readonly Patch[] {
  const date = String(finding.evidence.date ?? '');
  if (date === '') return [];

  const sameDay = items
    .filter((i) => i.date === date && i.itemType !== 'LODGING')
    .sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));

  const kindOf = (item: AuditItem): IndoorOutdoor | null =>
    item.lclsSystm2 === null ? null : indoorOutdoor[item.lclsSystm2] ?? null;

  // 뒤쪽 야외 ↔ 앞쪽 실내. 그런 쌍이 있어야 바꿀 이유가 있다
  const outdoorLast = [...sameDay].reverse().find((i) => kindOf(i) === 'OUTDOOR');
  const indoorFirst = sameDay.find((i) => kindOf(i) === 'INDOOR');
  if (outdoorLast === undefined || indoorFirst === undefined) return [];
  if (toMinutes(indoorFirst.startTime) >= toMinutes(outdoorLast.startTime)) return [];

  return [{
    patchId: patchId(0), type: 'REORDER', targetItemId: indoorFirst.id,
    payload: { swapWithItemId: outdoorLast.id },
  }];
}

/**
 * R08 — 뒤 일정 뒤로 이동 · 방문 순서 재배열 (FR-RU-083 ①②).
 *
 * ③ 더 가까운 동일유형 교체는 외부 조회가 필요해 `patch-remote` 가 낸다.
 *
 * ①은 부족한 만큼 뒤 일정을 통째로 민다. 뒤에 또 일정이 있으면 밀린 자리에서 겹칠 수
 * 있는데, 그건 `patch-preview` 가 충돌로 잡아 준다 — R03 이 같은 방식이다.
 *
 * ②는 **더 가까워지는 교체만** 낸다. 순서를 바꿔 봤자 더 멀어지는 제안을 낼 수는 없다.
 * 실제 이동시간은 반영 후 재검수에서 R08 이 다시 본다 (직선거리로 판정하지 않는다).
 */
function r08(finding: Finding, items: readonly AuditItem[]): readonly Patch[] {
  const from = items.find((i) => i.id === finding.targetItemId);
  const to = items.find((i) => i.id === finding.targetItemId2);
  const shortfall = Number(finding.evidence.shortfallMinutes);
  if (from === undefined || to === undefined || !Number.isFinite(shortfall) || shortfall <= 0) return [];

  const out: Patch[] = [];

  // ① 뒤 일정을 부족한 만큼 뒤로 민다
  out.push({
    patchId: patchId(out.length), type: 'TIME_SHIFT', targetItemId: to.id,
    payload: {
      newStartTime: addMinutes(to.startTime, shortfall),
      ...(to.endTime === null ? {} : { newEndTime: addMinutes(to.endTime, shortfall) }),
    },
  });

  // ② 같은 일차 안에서 바꿔 놓으면 더 가까워지는 항목
  const swap = closerSwap(from, to, items);
  if (swap !== null) {
    out.push({
      patchId: patchId(out.length), type: 'REORDER', targetItemId: to.id,
      payload: { swapWithItemId: swap.id },
    });
  }
  return out;
}

/**
 * `to` 와 자리를 바꿨을 때 `from` 에서 **더 가까워지는** 항목.
 *
 * 직선거리로 고른다 — 후보마다 지도 API 를 부를 수 없다. 판정이 아니라 고르기이고,
 * 실제 이동시간은 반영 후 재검수가 본다 (`engine/geo` 주석).
 */
function closerSwap(from: AuditItem, to: AuditItem, items: readonly AuditItem[]): AuditItem | null {
  const origin = pointOf(from);
  const target = pointOf(to);
  if (origin === null || target === null) return null;
  const current = straightMeters(origin, target);

  let best: { item: AuditItem; distance: number } | null = null;
  for (const candidate of items) {
    if (candidate.id === to.id || candidate.id === from.id) continue;
    if (candidate.dayNo !== to.dayNo || candidate.itemType !== to.itemType) continue;
    const point = pointOf(candidate);
    if (point === null) continue;
    const distance = straightMeters(origin, point);
    if (distance >= current) continue;
    if (best === null || distance < best.distance) best = { item: candidate, distance };
  }
  return best?.item ?? null;
}

/**
 * R07 — 일정 공백 구간에 식사 삽입 (FR-RU-073).
 *
 * 가장 긴 공백을 찾아 그 앞쪽에 최소 식사 시간만큼 넣는다. 공백이 모자라면 제안하지 않는다 —
 * 넣자마자 R03 시간 중복이 날 수정안을 제시할 수는 없다.
 */
function r07(finding: Finding, items: readonly AuditItem[]): readonly Patch[] {
  const dayNo = Number(finding.evidence.dayNo);
  const sameDay = items
    .filter((i) => i.dayNo === dayNo && i.endTime !== null && i.itemType !== 'LODGING')
    .sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
  if (sameDay.length < 2) return [];

  const need = SETTING_DEFAULTS.r07MealMinutes;
  let best: { after: AuditItem; gap: number } | null = null;
  for (let i = 0; i < sameDay.length - 1; i++) {
    const a = sameDay[i] as AuditItem;
    const b = sameDay[i + 1] as AuditItem;
    const gap = toMinutes(b.startTime) - toMinutes(a.endTime as string);
    if (gap >= need && (best === null || gap > best.gap)) best = { after: a, gap };
  }
  if (best === null) return [];

  const start = best.after.endTime as string;
  return [{
    patchId: patchId(0), type: 'INSERT_ITEM', targetItemId: best.after.id,
    payload: { dayNo, afterItemId: best.after.id, startTime: start, endTime: addMinutes(start, need), itemType: 'MEAL' },
  }];
}

/**
 * 넣을 자리와 채울 중분류 (R09 ① · R10 · FR-RU-093 ① · 103).
 *
 * **자리 계산은 0콜이다.** 콘텐츠 조회만 외부에 맡긴다 — 자리를 못 찾으면 조회할 이유도 없다.
 *
 * R09 는 그 날, R10 은 상품 전체에서 가장 넉넉한 빈 구간을 고른다. 앞뒤로 여유를 둔다 —
 * 맞붙여 넣으면 반영 후 재검수에서 「배정된 시간 0분」 오류가 난다 (R08).
 */
export interface InsertionRequest {
  /** 조회 중심이 될 항목. 그 근처에서 찾는다 */
  readonly anchor: AuditItem;
  readonly slot: { dayNo: number; afterItemId: number | null; startTime: string; endTime: string };
  /** 이 중분류 중 하나여야 한다. 비면 안 따진다 */
  readonly wantLcls2: readonly string[];
}

export function planInsertion(
  finding: Finding,
  items: readonly AuditItem[],
  indoorOutdoor: Readonly<Record<string, IndoorOutdoor>>,
  dwellMinutes = SETTING_DEFAULTS.dwellFallbackMinutes,
): InsertionRequest | null {
  const scope = insertionScope(finding, items, indoorOutdoor);
  if (scope === null || scope.candidates.length === 0) return null;

  // 가장 넉넉한 구간에 넣는다. 좁은 데 억지로 끼우면 뒤가 밀린다
  let best: { after: AuditItem; gap: number } | null = null;
  for (const day of [...new Set(scope.candidates.map((i) => i.dayNo))]) {
    const sameDay = scope.candidates
      .filter((i) => i.dayNo === day && i.endTime !== null && i.itemType !== 'LODGING')
      .sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
    for (let i = 0; i < sameDay.length - 1; i++) {
      const a = sameDay[i] as AuditItem;
      const b = sameDay[i + 1] as AuditItem;
      const gap = toMinutes(b.startTime) - toMinutes(a.endTime as string);
      if (gap >= dwellMinutes + MIN_TRANSFER_MINUTES * 2 && (best === null || gap > best.gap)) {
        best = { after: a, gap };
      }
    }
  }
  if (best === null) return null;

  const start = addMinutes(best.after.endTime as string, MIN_TRANSFER_MINUTES);
  return {
    anchor: best.after,
    slot: { dayNo: best.after.dayNo, afterItemId: best.after.id, startTime: start, endTime: addMinutes(start, dwellMinutes) },
    wantLcls2: scope.wantLcls2,
  };
}

/** 어느 항목들 사이에 넣을 것이고 무엇으로 채울 것인가 */
function insertionScope(
  finding: Finding,
  items: readonly AuditItem[],
  indoorOutdoor: Readonly<Record<string, IndoorOutdoor>>,
): { candidates: readonly AuditItem[]; wantLcls2: readonly string[] } | null {
  if (finding.ruleCode === 'R10') {
    const missing = finding.evidence.missingLcls2;
    // 결손 유형을 모르면 무엇을 넣을지도 모른다 (FR-RU-051)
    if (!Array.isArray(missing) || missing.length === 0) return null;
    return { candidates: items, wantLcls2: missing.map(String) };
  }

  if (finding.ruleCode === 'R09') {
    const date = String(finding.evidence.date ?? '');
    if (date === '') return null;
    // 실내로 분류된 중분류만 채운다. 표에 없는 것은 실내라고 말할 수 없다
    const indoor = Object.entries(indoorOutdoor).filter(([, v]) => v === 'INDOOR').map(([k]) => k);
    return indoor.length === 0 ? null : { candidates: items.filter((i) => i.date === date), wantLcls2: indoor };
  }
  return null;
}

/** R04 가 지목한 반복 항목 중 **마지막 것**. 대체 수정안의 대상이다 (FR-RU-043) */
export function lastRepeated(finding: Finding, items: readonly AuditItem[]): AuditItem | null {
  if (finding.ruleCode !== 'R04') return null;
  const ids = finding.evidence.itemIds;
  if (!Array.isArray(ids) || ids.length < 2) return null;
  const repeated = ids
    .map((id) => items.find((i) => i.id === Number(id)))
    .filter((i): i is AuditItem => i !== undefined)
    .sort((a, b) => (a.dayNo - b.dayNo) || (toMinutes(a.startTime) - toMinutes(b.startTime)));
  return repeated[repeated.length - 1] ?? null;
}
