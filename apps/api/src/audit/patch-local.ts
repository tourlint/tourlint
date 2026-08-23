import { SETTING_DEFAULTS } from '@tourlint/shared';
import { addDays, formatIsoDate, parseIsoDate } from '../engine/calendar/dates';
import type { HolidayCalendar } from '../engine/calendar/holidays';
import { evaluateClosed } from '../engine/rules/r01-operating';
import { addMinutes } from '../engine/itinerary/dwell';
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
}

export function proposeLocalPatches(input: LocalPatchInput): readonly Patch[] {
  const { finding, items } = input;
  const target = items.find((i) => i.id === finding.targetItemId);
  if (target === undefined) return [];

  switch (finding.ruleCode) {
    case 'R01': return r01(finding, target, items, input.holidays);
    case 'R02': return r02(finding, target);
    case 'R03': return r03(finding, items);
    case 'R07': return r07(finding, items);
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
    const day = openDayFor(target, items, holidays);
    if (day !== null) {
      out.push({
        patchId: patchId(out.length), type: 'TIME_SHIFT', targetItemId: target.id,
        payload: { newDayNo: day.dayNo, newStartTime: target.startTime },
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
 * 그 콘텐츠가 **열려 있는** 다른 일차를 찾는다.
 *
 * 아무 날이나 제안하면 옮긴 날도 휴무라 다시 차단이 난다. 상품 안의 다른 일차를 실제로
 * 판정해 보고 열려 있는 날만 고른다. 판정 로직은 R01 것을 그대로 쓴다 — 수정안이 규칙과
 * 다른 기준으로 날짜를 고르면 반영 후 재검수에서 또 걸린다.
 */
function openDayFor(
  target: AuditItem,
  items: readonly AuditItem[],
  holidays: HolidayCalendar,
): { dayNo: number } | null {
  const normalized = target.content?.normalized ?? null;
  const base = parseIsoDate(target.date);
  if (normalized === null || base === null) return null;

  const days = [...new Set(items.map((i) => i.dayNo))].sort((a, b) => a - b);
  for (const dayNo of days) {
    if (dayNo === target.dayNo) continue;
    const date = addDays(base, dayNo - target.dayNo);
    const verdict = evaluateClosed(normalized, date, holidays);
    if (verdict.kind === 'OPEN') return { dayNo };
    void formatIsoDate;
  }
  return null;
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
