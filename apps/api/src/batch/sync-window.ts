import { addDays, formatIsoDate, parseIsoDate, type IsoDate } from '../engine/calendar/dates';

/**
 * 배치가 조회할 날짜 창 (FR-MO-010 · 011 · 015).
 *
 * **순수 함수다.** 시계는 인자로 받는다 — 배치가 언제 도는지에 따라 결과가 달라지면
 * 재현할 수가 없다.
 *
 * ⚠️ 모든 날짜는 **한국 시간 기준**이다. 배포 환경이 UTC 라 서버 시계를 그대로 쓰면
 *    오후 9시 이후 실행이 하루 전 날짜를 본다.
 */

const KST_OFFSET_MINUTES = 9 * 60;

/**
 * 한 번에 순회할 날짜 상한.
 *
 * 오래 멈춰 있다 돌면 밀린 날짜가 쌓인다. 하루 한 콜씩이라 30일이면 30콜인데, 예산
 * 800건 중 그만큼을 배치가 먼저 먹으면 정작 검수할 몫이 준다. 남은 날짜는 다음 배치가
 * 이어 받는다 — `last_covered` 가 처리한 데까지만 올라가기 때문이다.
 */
export const MAX_DAYS_PER_RUN = 14;

/** 한국 시간 기준 오늘 */
export function kstToday(now: Date): IsoDate {
  return new Date(now.getTime() + KST_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

/** 한국 시간 기준 요일. 0 = 일요일 */
export function kstDayOfWeek(now: Date): number {
  return new Date(now.getTime() + KST_OFFSET_MINUTES * 60_000).getUTCDay();
}

/**
 * 주말인가 (FR-MO-010).
 *
 * 공사가 주말에도 데이터를 갱신하지만 배치는 평일만 돈다. 주말 분은 월요일 배치가
 * 날짜를 순회하며 함께 가져간다 — 그래서 순회가 필요하다.
 */
export function isWeekend(now: Date): boolean {
  const day = kstDayOfWeek(now);
  return day === 0 || day === 6;
}

/**
 * 조회할 날짜들. **직전 성공일 다음 날부터 어제까지** (FR-MO-011).
 *
 * 오늘을 넣지 않는 이유 — 공사가 하루 종일 갱신해서 지금 부르면 오늘 분이 덜 찬 채로
 * 온다. 그걸 처리한 것으로 치면 나머지를 영영 못 본다 (EI-KT-011 실측: 같은 일자가
 * 새벽 11건 · 오후 177건).
 *
 * 한 번도 안 돌았으면 **어제 하루만** 본다. 시작점이 없다고 과거를 통째로 훑으면
 * 예산이 남지 않는다.
 */
export function pendingDates(lastCovered: IsoDate | null, now: Date, maxDays = MAX_DAYS_PER_RUN): readonly IsoDate[] {
  const today = parseIsoDate(kstToday(now));
  if (today === null) return [];
  const yesterday = addDays(today, -1);

  const start = lastCovered === null ? yesterday : nextDayOf(lastCovered);
  if (start === null) return [];

  const out: IsoDate[] = [];
  let cursor = start;
  while (out.length < maxDays) {
    const iso = formatIsoDate(cursor);
    // 어제를 넘어가면 멈춘다. 오늘은 아직 덜 찬 날이다
    if (iso > formatIsoDate(yesterday)) break;
    out.push(iso);
    cursor = addDays(cursor, 1);
  }
  return out;
}

function nextDayOf(iso: IsoDate) {
  const d = parseIsoDate(iso);
  return d === null ? null : addDays(d, 1);
}

/** 공사가 받는 형식은 `YYYYMMDD` 다 */
export function toKtoDate(iso: IsoDate): string {
  return iso.replace(/-/g, '');
}
