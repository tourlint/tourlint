"use client";

// 일정 입력 (UI-S2-007·008). 일차별 섹션 · 항목별 시작/종료/장소명/유형 · 추가·삭제·순서변경.
// 유형은 lcls-codes(관광정보 분류)로 채운다. 종료시간을 비우면 검수가 중분류별 기본 체류시간으로
// 채운다 (FR-IN-011). 분류를 아는 줄은 채워질 시각과 「기본값 적용 · N분」 을 미리 보인다 (UI-S2-009).

import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Section, SelectInput, TextInput } from "./controls";
import { SchedulePlaceInput, type PlaceInputHandle } from "./schedule-place-input";
import { canAnchor } from "./schedule-place-search";
import { ITEM_TYPE_OPTIONS, dayCount, type ItemType, type Nights, type Schedule, type ScheduleItem } from "./types";
import { dwellDefault, knownLcls2, type DwellDefault } from "../../../lib/dwell-preview";
import { StatusBadge } from "../../../components/badges";

/**
 * 그 줄의 끝 시각이 기본 체류시간에서 오는가 (FR-IN-011 · UI-S2-009). 분류는 불러온 줄이면 저장된
 * 분류(고르는 중 · 직접 정한 곳이면 모름), 이 화면에서 고른 줄이면 고른 곳의 분류다. 모르면 시각을
 * 짓지 않는다.
 */
export function dwellOfRow(it: ScheduleItem): DwellDefault | null {
  const lcls2 = it.saved !== undefined
    ? knownLcls2(it.saved.matchStatus, it.saved.lcls2)
    : it.content ? (it.content.lcls2 ?? null) : undefined;
  return dwellDefault({
    start: it.start,
    end: it.end === "" ? null : it.end,
    itemType: it.itemType,
    lcls2,
    // 불러온 끝 시각이 체류시간으로 채운 값이고 아직 손대지 않았다
    endFromDwell: it.saved !== undefined && it.saved.endTimeSource !== undefined
      && it.saved.endTimeSource !== "INPUT" && it.end === it.saved.end,
  });
}

export function ScheduleEditor({
  nights,
  schedule,
  onChange,
  regnCd = "",
  signguCd = null,
  regionLabel = "이 지역",
  anchorId = null,
  onAnchorChange,
}: {
  nights: Nights;
  schedule: Schedule;
  onChange: Dispatch<SetStateAction<Schedule>>;
  // 입력하는 순간 목록에서 고르기(UI-S2-020)용 지역. 등록 폼의 여행 지역에서 온다
  regnCd?: string;
  signguCd?: string | null;
  regionLabel?: string;
  // 미확정 줄은 장소 후보 확인을 거친 뒤 근처 3km 기준으로 고른다.
  anchorId?: string | null;
  onAnchorChange?: (id: string | null) => void;
}) {
  const [activeDay, setActiveDay] = useState(0);
  const idSeq = useRef(0);
  const placeInputs = useRef(new Map<string, PlaceInputHandle>());
  const requestedAnchor = useRef<string | null>(null);

  const days = dayCount(nights);
  // 박수가 줄어 일수가 축소되면 activeDay 가 범위를 벗어날 수 있다. 상태를 effect 로
  // 되돌리는 대신 렌더 시점에 클램프한다.
  const activeIdx = Math.min(activeDay, days - 1);

  function newItem(): ScheduleItem {
    idSeq.current += 1;
    return { id: `it-${idSeq.current}`, start: "", end: "", place: "", itemType: "", origin: "MANUAL" };
  }
  function updateDay(day: number, items: ScheduleItem[]) {
    onChange((current) => current.map((d, i) => (i === day ? items : d)));
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
    onChange((current) => current.map((items, i) => i !== day ? items
      : items.map((it) => it.id === id ? { ...it, ...patch } : it)));
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
      description="일차별로 방문 항목을 입력합니다. 종료시간을 비우면 장소 종류별 기본 체류시간이 적용됩니다. 「기준」을 누르면 근처 3km 장소를 볼 수 있습니다. 자연어·엑셀로 가져온 장소는 후보를 확인한 뒤 기준으로 연결됩니다."
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
        {items.map((it, index) => {
          const dwell = dwellOfRow(it);
          return (
          <div
            key={it.id}
            className={`flex flex-wrap items-end gap-2 rounded-lg border p-3 ${
              anchorId === it.id && canAnchor(it.content)
                ? "border-indigo-400 bg-indigo-50/40 dark:border-indigo-500 dark:bg-indigo-950/20"
                : "border-slate-200 dark:border-slate-800"
            }`}
          >
            {/* 고른 줄 체크 — 이 줄을 오른쪽 장소 담기의 근처 3km 기준으로 삼는다.
                미확정 줄도 누를 수 있고, 장소·좌표 확인 후에만 기준이 된다. */}
            <label
              className="flex flex-col items-center gap-1 self-stretch justify-center text-[10px] text-slate-500 dark:text-slate-400"
              title={
                canAnchor(it.content)
                  ? "이 줄을 기준으로 근처 3km 장소를 봅니다"
                  : "장소를 확인하고 근처 3km 기준으로 사용합니다"
              }
            >
              <input
                type="checkbox"
                aria-label={`${it.place || "빈 일정"} 기준`}
                checked={anchorId === it.id && canAnchor(it.content)}
                // 직접 정한 곳 · 걷기 길은 좌표가 없어 근처 3km 의 기준이 될 수 없다
                disabled={onAnchorChange === undefined || it.excluded === true || it.walk !== undefined}
                onChange={(e) => {
                  requestedAnchor.current = it.id;
                  if (!e.target.checked) { requestedAnchor.current = null; onAnchorChange?.(null); }
                  else if (canAnchor(it.content)) onAnchorChange?.(it.id);
                  else placeInputs.current.get(it.id)?.chooseAsAnchor();
                }}
                className="h-4 w-4 accent-indigo-600 disabled:opacity-30"
              />
              기준
            </label>
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
            <SchedulePlaceInput
              ref={(handle) => { if (handle) placeInputs.current.set(it.id, handle); else placeInputs.current.delete(it.id); }}
              onAnchorReady={() => { if (requestedAnchor.current === it.id) onAnchorChange?.(it.id); }}
              value={it.place}
              content={it.content ?? null}
              excluded={it.excluded === true}
              walk={it.walk !== undefined}
              // 편집 화면의 저장된 고른 곳은 여기서 직접 정한 곳으로 바꿀 길이 없다
              canExclude={it.saved === undefined || it.saved.matchStatus !== "CONFIRMED"}
              // 저장된 직접 정한 곳은 고르는 중으로 되돌릴 길이 없다 (UI-S2-021)
              canReselect={it.saved === undefined || it.saved.matchStatus !== "EXCLUDED"}
              regnCd={regnCd}
              signguCd={signguCd}
              regionLabel={regionLabel}
              // 고른 상태에선 입력칸이 ✓ 뷰라 타이핑이 안 되고, 다시 고르기로만 매칭을 지운다.
              // 그래서 patch 를 그대로 병합하면 된다(pick=place+content, 편집=place, 해제=content:null)
              onChange={(patch) => patchItem(activeIdx, it.id, patch)}
            />
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
            {dwell !== null && (
              <p className="flex basis-full flex-wrap items-center gap-2 text-xs text-slate-400 dark:text-slate-500">
                {dwell.preview && <span>끝 시간을 비우면 {dwell.end}까지로 채워요</span>}
                <StatusBadge status="DEFAULT_APPLIED" detail={`${dwell.minutes}분`} />
              </p>
            )}
          </div>
          );
        })}
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
