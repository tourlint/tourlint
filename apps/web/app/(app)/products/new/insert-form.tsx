"use client";

// 어느 일차 · 어느 자리에 넣을지 고르는 작은 폼 (개편안 4-3 넣을 위치 · UI-S2-050). 등록 · 편집 화면
// 장소 담기의 장소 카드와 걷기 길 카드가 같이 쓴다. 맨 앞 · 맨 뒤 포함.

import { useMemo, useState } from "react";
import { dayCount, type Nights, type Schedule } from "./types";

export function InsertForm({ nights, schedule, onConfirm }: { nights: Nights; schedule: Schedule; onConfirm: (dayIdx: number, insertAt: number) => void }) {
  const [dayIdx, setDayIdx] = useState(0);
  const [insertAt, setInsertAt] = useState(0);
  const days = dayCount(nights);
  const items = useMemo(() => schedule[dayIdx] ?? [], [schedule, dayIdx]);

  // 위치 옵션: 맨 앞(0) · 각 항목 다음(i+1). 마지막 항목 다음 = 맨 뒤.
  const positions = useMemo(() => {
    const opts: { value: number; label: string }[] = [{ value: 0, label: items.length === 0 ? "맨 앞 (첫 항목)" : "맨 앞" }];
    items.forEach((it, i) => {
      const name = it.place.trim() !== "" ? it.place : `${i + 1}번째 항목`;
      opts.push({ value: i + 1, label: i === items.length - 1 ? `${name} 다음 (맨 뒤)` : `${name} 다음` });
    });
    return opts;
  }, [items]);

  // 일차를 바꾸면 위치가 범위를 벗어날 수 있어 맨 앞으로 되돌린다
  const safeInsertAt = Math.min(insertAt, items.length);

  return (
    <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-2 dark:border-slate-800">
      <label className="flex flex-col gap-1 text-[11px] text-slate-500 dark:text-slate-400">
        일차
        <select
          value={dayIdx}
          onChange={(e) => { setDayIdx(Number(e.target.value)); setInsertAt(0); }}
          className="rounded-md border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
        >
          {Array.from({ length: days }, (_, d) => (
            <option key={d} value={d}>{d + 1}일차</option>
          ))}
        </select>
      </label>
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] text-slate-500 dark:text-slate-400">
        넣을 위치
        <select
          value={safeInsertAt}
          onChange={(e) => setInsertAt(Number(e.target.value))}
          className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
        >
          {positions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={() => onConfirm(dayIdx, safeInsertAt)}
        className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500"
      >
        여기에 넣기
      </button>
    </div>
  );
}
