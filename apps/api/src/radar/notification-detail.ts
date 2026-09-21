import type { MatchCondition } from '../batch/impact-finder';
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
  // 표출 중단 · 새 소식은 조건마다 이미 다른 말을 한다. 거기에 장소 이름이 붙는다
  if (f.hidden || f.condition >= 4) return base;

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
  if (!f.hasBefore) return '검수한 뒤에 담은 곳이라 견줄 이전 검수 기록이 없습니다.';
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
