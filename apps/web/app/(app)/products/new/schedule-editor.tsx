"use client";

// 일정 입력 (UI-S2-007·008). 일차별 섹션 · 항목별 시작/종료/장소명/유형 · 추가·삭제·순서변경.
// 유형은 lcls-codes(관광정보 분류)로 채운다. 종료시간을 비우면 저장 시 중분류별 기본
// 체류시간이 보완되고 `기본값 적용` 배지가 붙는다 (FR-IN-011) — 보완은 뒷단 몫이라 후속.

import { useRef, useState } from "react";
import { Section, SelectInput, TextInput } from "./controls";
import { ITEM_TYPE_OPTIONS, dayCount, type ItemType, type Nights, type Schedule, type ScheduleItem } from "./types";

export function ScheduleEditor({
  nights,
  schedule,
  onChange,
}: {
  nights: Nights;
  schedule: Schedule;
  onChange: (s: Schedule) => void;
}) {
  const [activeDay, setActiveDay] = useState(0);
  const idSeq = useRef(0);

  const days = dayCount(nights);
  // 박수가 줄어 일수가 축소되면 activeDay 가 범위를 벗어날 수 있다. 상태를 effect 로
  // 되돌리는 대신 렌더 시점에 클램프한다.
  const activeIdx = Math.min(activeDay, days - 1);

  function newItem(): ScheduleItem {
    idSeq.current += 1;
    return { id: `it-${idSeq.current}`, start: "", end: "", place: "", itemType: "" };
  }
  function updateDay(day: number, items: ScheduleItem[]) {
    onChange(schedule.map((d, i) => (i === day ? items : d)));
  }
  function addItem(day: number) {
    updateDay(day, [...(schedule[day] ?? []), newItem()]);
  }
  function removeItem(day: number, id: string) {
    updateDay(
      day,
      (schedule[day] ?? []).filter((it) => it.id !== id),
    );
  }
  function patchItem(day: number, id: string, patch: Partial<ScheduleItem>) {
    updateDay(
      day,
      (schedule[day] ?? []).map((it) => (it.id === id ? { ...it, ...patch } : it)),
    );
  }
  function move(day: number, index: number, dir: -1 | 1) {
    const items = [...(schedule[day] ?? [])];
    const j = index + dir;
    if (j < 0 || j >= items.length) return;
    [items[index], items[j]] = [items[j], items[index]];
    updateDay(day, items);
  }

  const items = schedule[activeIdx] ?? [];

  return (
    <Section
      title="일정"
      description="일차별로 방문 항목을 입력합니다. 종료시간을 비우면 중분류별 기본 체류시간이 적용됩니다."
    >
      <div role="tablist" aria-label="일차 선택" className="flex flex-wrap gap-1">
        {Array.from({ length: days }, (_, d) => {
          const active = d === activeIdx;
          const count = (schedule[d] ?? []).length;
          return (
            <button
              key={d}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveDay(d)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                active
                  ? "bg-indigo-600 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
              }`}
            >
              {d + 1}일차{count > 0 && <span className="ml-1 opacity-70">({count})</span>}
            </button>
          );
        })}
      </div>

      <div className="space-y-2">
        {items.length === 0 && (
          <p className="rounded-lg border border-dashed border-slate-300 py-6 text-center text-sm text-slate-400 dark:border-slate-700 dark:text-slate-500">
            {activeIdx + 1}일차 일정이 비어 있습니다. 항목을 추가하세요.
          </p>
        )}
        {items.map((it, index) => (
          <div
            key={it.id}
            className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
          >
            <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
              시작
              <TextInput
                type="time"
                value={it.start}
                onChange={(e) => patchItem(activeIdx, it.id, { start: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
              종료
              <TextInput
                type="time"
                value={it.end}
                onChange={(e) => patchItem(activeIdx, it.id, { end: e.target.value })}
              />
            </label>
            <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
              장소명
              <TextInput
                type="text"
                value={it.place}
                placeholder="예: 중앙시장"
                onChange={(e) => patchItem(activeIdx, it.id, { place: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
              유형
              <SelectInput
                value={it.itemType}
                onChange={(e) => patchItem(activeIdx, it.id, { itemType: e.target.value as ItemType | "" })}
              >
                <option value="">선택</option>
                {ITEM_TYPE_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </SelectInput>
            </label>
            <div className="flex gap-1">
              <button
                type="button"
                aria-label="위로"
                onClick={() => move(activeIdx, index, -1)}
                disabled={index === 0}
                className="rounded-md border border-slate-300 px-2 py-2 text-sm text-slate-600 transition hover:bg-slate-100 disabled:opacity-30 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                ↑
              </button>
              <button
                type="button"
                aria-label="아래로"
                onClick={() => move(activeIdx, index, 1)}
                disabled={index === items.length - 1}
                className="rounded-md border border-slate-300 px-2 py-2 text-sm text-slate-600 transition hover:bg-slate-100 disabled:opacity-30 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => removeItem(activeIdx, it.id)}
                className="rounded-md border border-slate-300 px-2 py-2 text-sm font-medium text-rose-600 transition hover:bg-rose-50 dark:border-slate-700 dark:text-rose-400 dark:hover:bg-rose-950/40"
              >
                삭제
              </button>
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={() => addItem(activeIdx)}
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        + 항목 추가
      </button>
    </Section>
  );
}
