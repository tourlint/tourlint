"use client";

// 일차 요약 (UI-S2-025). "1일차 · 6곳 · 10:00 – 18:50" 처럼 곳 수와 처음~끝 시간만 적는다.
// 점수 · 이동 합계 · 야외 비중 같은 판정 값은 두지 않는다 (기획 화면에 판정은 없다).

import type { ProductItem } from "../../../../lib/api";

export function DaySummary({ day, items }: { day: number; items: ProductItem[] }) {
  const starts = items.map((it) => it.start).filter((s) => s !== "");
  const ends = items.map((it) => it.end ?? "").filter((s) => s !== "");
  const first = starts.length > 0 ? starts.reduce((a, b) => (a < b ? a : b)) : null;
  const last = ends.length > 0 ? ends.reduce((a, b) => (a > b ? a : b)) : null;
  const span = first !== null && last !== null ? ` · ${first} – ${last}` : "";
  return (
    <p className="text-xs text-slate-500 dark:text-slate-400">
      {day}일차 · {items.length}곳{span}
    </p>
  );
}
