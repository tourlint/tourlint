"use client";

// 장소 담기 필터 줄 (UI-S2-038 · UI-S2-043). 기획 · 등록 화면과 검수 서랍이 같이 쓴다.
//   · 필터가 하나라도 켜지면 「필터 끄기」
//   · 무장애 · 반려동물 목록을 못 받았으면(briefing 의 그 값이 null) 그 필터만 「지금은 볼 수 없어요」 —
//     켜 두면 모르는 곳이 모두 빠져 0곳이 된다. 서비스 이름은 적지 않는다 (UI-CM-040)

import type { PlanBriefing } from "../../lib/api";

export interface PlaceFilterState {
  wheelchair: boolean;
  pet: boolean;
  indoor: boolean;
}

/** 지금 쓸 수 없는 필터. 브리핑을 아직 못 받았으면 막지 않는다 — 모르는 것을 장애로 적지 않는다 */
export function unavailableFilters(briefing: PlanBriefing | null): { wheelchair: boolean; pet: boolean } {
  return {
    wheelchair: briefing !== null && briefing.accessible === null,
    pet: briefing !== null && briefing.pet === null,
  };
}

/** 조회에 싣는 필터 — 쓸 수 없는 필터는 켜져 있어도 걸지 않는다 */
export function appliedFilters(filters: PlaceFilterState, off: { wheelchair: boolean; pet: boolean }): PlaceFilterState {
  return { wheelchair: filters.wheelchair && !off.wheelchair, pet: filters.pet && !off.pet, indoor: filters.indoor };
}

export function hasFilter(filters: PlaceFilterState): boolean {
  return filters.wheelchair || filters.pet || filters.indoor;
}

const FILTERS = [["wheelchair", "휠체어 가능"], ["pet", "반려동물 동반"], ["indoor", "실내만"]] as const;

export function PlaceFilters({
  filters,
  off,
  onToggle,
  onClear,
}: {
  filters: PlaceFilterState;
  off: { wheelchair: boolean; pet: boolean };
  onToggle: (key: keyof PlaceFilterState) => void;
  onClear: () => void;
}) {
  const applied = appliedFilters(filters, off);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
      {FILTERS.map(([key, label]) => {
        const unavailable = key !== "indoor" && off[key];
        return (
          <label key={key} className={`flex items-center gap-1 ${unavailable ? "text-slate-400 dark:text-slate-500" : "cursor-pointer"}`}>
            <input type="checkbox" checked={applied[key]} disabled={unavailable} onChange={() => onToggle(key)} />
            {label}
            {unavailable && <span> · 지금은 볼 수 없어요</span>}
          </label>
        );
      })}
      {hasFilter(applied) && (
        <button type="button" onClick={onClear} className="text-xs text-slate-500 underline-offset-2 hover:underline dark:text-slate-400">
          필터 끄기
        </button>
      )}
    </div>
  );
}

/** 둘째 줄 아래 안내 한 줄 (UI-S2-037). 식당 · 카페 · 숙소는 정렬이 가까운 순 하나다 (FR-PL-011) */
export function NearGuide() {
  return <p className="mt-1 text-xs text-slate-400">식당 · 카페 · 숙소는 가까운 순으로 보여 드려요</p>;
}
