import type { MatchCondition } from '../batch/impact-finder';
import type { OpportunitySlot, SlotMissing, SlotPrecheck } from '../batch/opportunity';
import type { ChangeLine } from './change-diff';
import { notificationCopy, type NotificationCopy } from './notification-copy';

/**
 * 알림 한 건이 실제로 말할 수 있는 것 (#703 · UI-S7-003 · 004 · DB 명세서 4-5).
 *
 * 조건 번호로 고른 고정 문장만 보이면 카드가 전부 같은 말을 한다 — 2026-09-21 운영에서 바뀐 정보
 * 카드 네 장이 장소 이름만 다르고 세 문장이 같았다. 문장은 **저장하지 않고** 볼 때 이 사실들로
 * 만든다. 사실이 없으면 없는 대로 말한다. 지어내지 않는다 (FR-RU-051).
 */
export interface NotificationFacts {
  readonly condition: MatchCondition;
  readonly hidden: boolean;
  /** 그 곳이 일정에 든 줄 */
  readonly schedule: { readonly dayNo: number; readonly startTime: string } | null;
  /** 판독 결과 전 → 후. 견줄 두 검수가 다 있을 때만 의미가 있다 */
  readonly changes: readonly ChangeLine[];
  readonly hasBefore: boolean;
  readonly hasAfter: boolean;
  readonly eventPeriod: { readonly start: string; readonly end: string } | null;
  /** 행사 기간과 겹치는 여행 일차 (1부터) */
  readonly overlapDays: readonly number[];
  /** 새 소식의 넣을 자리와 사전 확인 (UI-S7-008). 배치가 남기기 전 알림에는 없다 */
  readonly opportunity?: OpportunityFacts | null;
}

/** 배치가 새 소식에 남긴 넣을 자리 · 사전 확인 (`body.slot` · `slotMissing` · `precheck`) */
export interface OpportunityFacts {
  readonly slot: OpportunitySlot | null;
  readonly slotMissing: SlotMissing | null;
  readonly precheck: SlotPrecheck | null;
}

/** `body` 에서 넣을 자리 · 사전 확인을 읽는다. 모양이 아니면 없는 것이다 — 지어내지 않는다 */
export function opportunityFactsOf(body: Readonly<Record<string, unknown>>): OpportunityFacts | null {
  const slot = readSlot(body.slot);
  const slotMissing = body.slotMissing === 'NO_GAP' || body.slotMissing === 'DWELL_UNKNOWN' ? body.slotMissing : null;
  if (slot === null && slotMissing === null) return null;
  return { slot, slotMissing: slot === null ? slotMissing : null, precheck: slot === null ? null : readPrecheck(body.precheck) };
}

function readSlot(v: unknown): OpportunitySlot | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const hhmm = /^\d{2}:\d{2}$/;
  if (typeof o.dayNo !== 'number' || typeof o.from !== 'string' || !hhmm.test(o.from)) return null;
  if (o.to !== null && (typeof o.to !== 'string' || !hhmm.test(o.to))) return null;
  if (typeof o.minutes !== 'number' || typeof o.dwellMinutes !== 'number') return null;
  return { dayNo: o.dayNo, from: o.from, to: o.to as string | null, minutes: o.minutes, dwellMinutes: o.dwellMinutes };
}

function readPrecheck(v: unknown): SlotPrecheck | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.travel !== 'FITS' && o.travel !== 'SHORT' && o.travel !== 'UNKNOWN') return null;
  const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  return {
    travel: o.travel,
    inMinutes: num(o.inMinutes),
    outMinutes: num(o.outMinutes),
    addedMinutes: num(o.addedMinutes),
    shortMinutes: num(o.shortMinutes),
    currentTimeBased: o.currentTimeBased === true,
  };
}

/** `2026-10-31` → `10월 31일`. 모양이 아니면 그대로 돌려준다 */
export function koreanDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m === null ? iso : `${String(Number(m[2]))}월 ${String(Number(m[3]))}일`;
}

/** 행사 기간이 여행 몇 일차와 겹치는가. 날짜를 못 읽으면 빈 배열이다 */
export function overlapDays(
  startDate: string,
  nights: number | null,
  period: { readonly start: string; readonly end: string } | null,
): readonly number[] {
  if (period === null || nights === null || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return [];
  const first = Date.parse(`${startDate}T00:00:00Z`);
  if (Number.isNaN(first)) return [];
  const out: number[] = [];
  for (let i = 0; i <= nights; i += 1) {
    const day = new Date(first + i * 86_400_000).toISOString().slice(0, 10);
    if (day >= period.start && day <= period.end) out.push(i + 1);
  }
  return out;
}

/** 공사 `modifiedtime`(`YYYYMMDDhhmmss`) → `YYYY-MM-DD`. 모양이 아니면 null */
export function modifiedOn(raw: unknown): string | null {
  const s = typeof raw === 'string' ? raw : '';
  return /^\d{8}/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

export function describeNotification(f: NotificationFacts): NotificationCopy {
  const base = notificationCopy(f.condition, f.hidden);
  if (f.hidden) return base;
  // 새 소식은 넣을 자리와 사전 확인을 말한다 (UI-S7-008). 배치가 남기기 전 알림은 조건 문장 그대로다
  if (f.condition >= 4) {
    const o = f.opportunity ?? null;
    return o === null ? base : { what: base.what, impact: slotSentence(o), action: precheckSentence(o) };
  }

  const where = f.schedule === null ? null : `${String(f.schedule.dayNo)}일차 ${f.schedule.startTime}`;

  if (f.condition === 1) {
    return {
      what: whatChanged(f),
      impact: where === null ? '' : `${where} 일정입니다.`,
      action: base.action,
    };
  }

  if (f.condition === 3) {
    return {
      what: eventSentence(f),
      impact: where === null
        ? '일정에 든 행사는 아닙니다. 여행지에서 여행일에 열립니다.'
        : `${where} 일정에 든 행사입니다.`,
      action: '행사 기간과 시간을 확인하고 필요하면 다시 검수하세요.',
    };
  }

  // 조건 2 — 같은 지역 · 출발 임박
  return {
    what: '여행지에 있는 곳의 관광정보가 수정됐습니다.',
    impact: '일정에 든 곳은 아닙니다. 출발일이 가까워 알려 드립니다.',
    action: base.action,
  };
}

function whatChanged(f: NotificationFacts): string {
  if (f.changes.length > 0) return `${f.changes.map((c) => c.label).join(' · ')} 정보가 바뀌었습니다.`;
  if (!f.hasBefore) return '검수한 뒤에 담은 곳이라 비교할 이전 검수 기록이 없습니다.';
  if (!f.hasAfter) return '판정에 쓰는 관광정보가 바뀌었습니다. 다시 검수하면 무엇이 달라졌는지 보입니다.';
  return '휴무일 · 운영시간은 그대로이고 그 밖의 판정 정보가 바뀌었습니다.';
}

function eventSentence(f: NotificationFacts): string {
  if (f.eventPeriod === null) return '여행일과 겹치는 행사의 관광정보가 수정됐습니다.';
  const { start, end } = f.eventPeriod;
  const when = start === end ? `행사일은 ${koreanDay(start)}입니다.` : `행사 기간은 ${koreanDay(start)} ~ ${koreanDay(end)}입니다.`;
  const days = f.overlapDays.length === 0 ? '' : ` 여행 ${f.overlapDays.map(String).join(' · ')}일차와 겹칩니다.`;
  return `${when}${days}`;
}

/** 넣을 자리 한 문장. 알림을 만들 때의 일정 기준이다 */
function slotSentence(o: OpportunityFacts): string {
  if (o.slot === null) {
    return o.slotMissing === 'NO_GAP'
      ? '일정에 넣을 만큼 빈 시간이 없어요. 넣으려면 다른 일정을 옮겨야 해요.'
      : '얼마나 머무는 곳인지 몰라 넣을 자리를 정하지 못했어요.';
  }
  const { dayNo, from, to, minutes, dwellMinutes } = o.slot;
  const when = to === null ? `${String(dayNo)}일차 ${from} 이후 빈 시간` : `${String(dayNo)}일차 ${from} ~ ${to} 빈 시간(${String(minutes)}분)`;
  return `${when}에 넣을 수 있어요. 머무는 시간은 약 ${String(dwellMinutes)}분으로 봤어요(알림 때 일정 기준).`;
}

/**
 * 사전 확인 한 문장 — 겹침(R03)과 이동(R08). 자리가 빈 시간 안이라 겹침은 없다. 이동은 잰 값으로만 말하고
 * 못 쟀으면 넣은 뒤 다시 검수에서 본다고 적는다.
 */
function precheckSentence(o: OpportunityFacts): string {
  if (o.slot === null) return '반영할지 검토하세요. 넣으면 다시 검수해 겹침과 이동을 확인합니다.';
  const p = o.precheck;
  if (p === null || p.travel === 'UNKNOWN' || p.inMinutes === null) {
    return '다른 일정과 겹치지 않아요. 이동시간은 넣은 뒤 다시 검수에서 확인해요.';
  }
  const legs = p.outMinutes === null
    ? `앞 일정에서 오는 이동(약 ${String(p.inMinutes)}분)`
    : `앞뒤 이동(약 ${String(p.inMinutes)}분 · ${String(p.outMinutes)}분)`;
  const basis = p.currentTimeBased ? ' 현재 시각 기준으로 잰 이동시간이에요.' : '';
  if (p.travel === 'SHORT') {
    return `다른 일정과 겹치지 않지만 ${legs}을 넣으면 ${String(p.shortMinutes ?? 0)}분이 모자라요. 앞뒤 일정을 옮겨야 해요.${basis}`;
  }
  const added = p.addedMinutes === null ? '' : ` 이동은 원래보다 약 ${String(p.addedMinutes)}분 늘어요.`;
  return `다른 일정과 겹치지 않고 ${legs}을 넣어도 빈 시간 안에 들어가요.${added}${basis}`;
}
