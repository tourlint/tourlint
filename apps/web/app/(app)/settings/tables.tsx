"use client";

// 중분류 기준표 — 읽기 전용 (UI-S8-008 · FR-OP-021). 장소 종류별 기본 체류시간과 실내 · 야외를 한 표에
// 두 열로 보이고 이름으로 찾는다. 모든 계정에 같은 표준이라 편집하지 않는다. 값은 @tourlint/shared 시드를
// 그대로 읽어 공사 호출 0콜로 그린다. 중분류 코드는 화면에 적지 않는다 — 사용자는 이름으로 찾는다.

import { useState } from "react";
import { DWELL_MINUTES_SEED, INDOOR_OUTDOOR_SEED, LCLS_SYSTM2, SETTING_DEFAULTS, type IndoorOutdoor } from "@tourlint/shared";

const IO_LABEL: Record<IndoorOutdoor, string> = { INDOOR: "실내", OUTDOOR: "야외", MIXED: "혼재" };

export interface PlaceKindRow {
  readonly code: string;
  readonly name: string;
  readonly dwellMinutes: number | null;
  readonly space: string | null;
}

/** 두 표의 중분류를 합친다. 한쪽에만 있는 종류는 다른 칸이 빈다 — 값을 지어 채우지 않는다 */
export function placeKindRows(): readonly PlaceKindRow[] {
  const codes = [...new Set([...Object.keys(DWELL_MINUTES_SEED), ...Object.keys(INDOOR_OUTDOOR_SEED)])].sort();
  return codes.map((code) => ({
    code,
    name: LCLS_SYSTM2[code]?.name ?? code,
    dwellMinutes: DWELL_MINUTES_SEED[code] ?? null,
    space: INDOOR_OUTDOOR_SEED[code] === undefined ? null : IO_LABEL[INDOOR_OUTDOOR_SEED[code]],
  }));
}

/** 이름으로만 찾는다 (검색만 · UI-S8-008). 공백은 무시한다 */
export function filterPlaceKinds(rows: readonly PlaceKindRow[], query: string): readonly PlaceKindRow[] {
  const q = query.replace(/\s+/g, "").toLocaleLowerCase();
  if (q === "") return rows;
  return rows.filter((r) => r.name.replace(/\s+/g, "").toLocaleLowerCase().includes(q));
}

export function PlaceKindTable() {
  const [query, setQuery] = useState("");
  const all = placeKindRows();
  const rows = filterPlaceKinds(all, query);
  return (
    <>
      <p className="mb-2 text-xs text-slate-400">
        종료 시각이 없는 일정의 체류시간과, 날씨 · 우천 판정의 야외 비중에 쓰는 표준 값입니다. 체류시간이 빈 종류는 숙박이면 끝 시각을 채우지 않고, 그 밖에는 {SETTING_DEFAULTS.dwellFallbackMinutes}분으로 채웁니다.
      </p>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="장소 종류 찾기"
        placeholder="장소 종류 찾기 (예: 카페)"
        className="mb-2 w-full rounded-md border border-slate-300 px-2 py-1 text-sm sm:w-64 dark:border-slate-700 dark:bg-slate-900"
      />
      <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
            <tr>
              <th className="p-2 font-medium">장소 종류</th>
              <th className="p-2 font-medium">기본 체류시간</th>
              <th className="p-2 font-medium">실내 · 야외</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code} className="border-t border-slate-100 dark:border-slate-800/60">
                <td className="p-2 text-slate-700 dark:text-slate-200">{r.name}</td>
                <td className="p-2 tabular-nums text-slate-700 dark:text-slate-200">{r.dwellMinutes === null ? "—" : `${r.dwellMinutes}분`}</td>
                <td className="p-2 text-slate-700 dark:text-slate-200">{r.space ?? "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={3} className="p-3 text-center text-xs text-slate-400">
                  「{query.trim()}」이(가) 들어간 장소 종류가 없어요. 다른 이름으로 찾아보세요.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
