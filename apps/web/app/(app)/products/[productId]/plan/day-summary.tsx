"use client";

// 일차 요약 (UI-S2-025). "1일차 · 6곳 · 10:00 – 18:50" 처럼 곳 수와 처음~끝 시간만 적는다.
// 점수 · 이동 합계 · 야외 비중 같은 판정 값은 두지 않는다 (기획 화면에 판정은 없다).

import type { ProductItem } from "../../../../lib/api";

/**
 * 하루의 처음 ~ 끝 시각 (#730).
 *
 * 끝은 종료 시각만 보면 안 된다. 종료를 안 적은 마지막 일정(14:30 숙소 도착)이 빠져 머리가
 * 「09:00 – 13:30」 으로 나왔다. 가장 늦은 것이 종료 없는 일정의 시작이면 「14:30 이후」 로 적는다.
 */
export function daySpan(items: Pick<ProductItem, "start" | "end">[]): string | null {
  const starts = items.map((it) => it.start).filter((s) => s !== "");
  if (starts.length === 0) return null;
  const first = starts.reduce((a, b) => (a < b ? a : b));
  const ends = items.map((it) => it.end ?? "").filter((s) => s !== "");
  const lastEnd = ends.length > 0 ? ends.reduce((a, b) => (a > b ? a : b)) : null;
  const openStarts = items.filter((it) => (it.end ?? "") === "" && it.start !== "").map((it) => it.start);
  const lastOpen = openStarts.length > 0 ? openStarts.reduce((a, b) => (a > b ? a : b)) : null;
  if (lastOpen !== null && (lastEnd === null || lastOpen >= lastEnd)) return `${first} – ${lastOpen} 이후`;
  return lastEnd === null ? null : `${first} – ${lastEnd}`;
}

export function DaySummary({ day, items }: { day: number; items: ProductItem[] }) {
  const range = daySpan(items);
  const span = range !== null ? ` · ${range}` : "";
  return (
    <p className="text-xs text-slate-500 dark:text-slate-400">
      {day}일차 · {items.length}곳{span}
    </p>
  );
}
