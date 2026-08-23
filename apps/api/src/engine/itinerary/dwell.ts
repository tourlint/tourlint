import { DWELL_MINUTES_SEED, SETTING_DEFAULTS, type EndTimeSource, type ItemType } from '@tourlint/shared';
import { toMinutes } from '../normalize/primitives';
import type { TimeOfDay } from '../normalize/types';

/**
 * 종료시간 보완 (FR-IN-011 · FR-RU-031).
 *
 * 사용자가 종료시간을 비워 넣는 일이 흔한데, 그러면 R03 시간 중복을 판정할 수 없다.
 * 중분류별 기본 체류시간으로 채운 뒤 판정하고, **보완했다는 사실을 결과에 남긴다.**
 *
 * 순수 함수다 — 같은 항목이면 언제나 같은 종료시간이 나온다 (NF-MT-001).
 */

export interface DwellInput {
  readonly startTime: TimeOfDay;
  readonly endTime: TimeOfDay | null;
  readonly itemType: ItemType;
  /** 신분류체계 중분류. 매핑이 없으면 기본값 90분 */
  readonly lclsSystm2: string | null;
}

export interface ResolvedEndTime {
  readonly endTime: TimeOfDay | null;
  readonly source: EndTimeSource;
  readonly dwellMinutes: number | null;
}

/**
 * 종료시간을 정한다.
 *
 * **숙박은 보완하지 않는다.** 입실 시각만 있는 항목에 체류시간을 더하면
 * `17:30 + 90분 = 19:00` 구간이 생겨 **없는 시간 중복**이 만들어진다 (FR-AU-011).
 */
export function resolveEndTime(
  item: DwellInput,
  table: Readonly<Record<string, number>> = DWELL_MINUTES_SEED,
): ResolvedEndTime {
  if (item.endTime !== null) {
    return { endTime: item.endTime, source: 'INPUT', dwellMinutes: null };
  }
  if (item.itemType === 'LODGING') {
    return { endTime: null, source: 'INPUT', dwellMinutes: null };
  }

  const mapped = item.lclsSystm2 === null ? undefined : table[item.lclsSystm2];
  const minutes = mapped ?? SETTING_DEFAULTS.dwellFallbackMinutes;

  return {
    endTime: addMinutes(item.startTime, minutes),
    source: mapped === undefined ? 'DWELL_FALLBACK' : 'DWELL_DEFAULT',
    dwellMinutes: minutes,
  };
}

/** 자정을 넘기면 `24:00` 에서 멈춘다 — 다음 날로 넘어가는 일정은 입력 단계가 막는다 */
export function addMinutes(time: TimeOfDay, minutes: number): TimeOfDay {
  const total = Math.min(toMinutes(time) + minutes, 24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
