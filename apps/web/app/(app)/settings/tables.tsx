"use client";

// 표준 기준표 — 읽기 전용 (UI-S8-005 · FR-OP-021). 중분류별 기본 체류시간과 실내 · 야외
// 매핑은 모든 계정에 같은 표준이라 편집하지 않는다. 값은 @tourlint/shared 시드를 그대로
// 읽어 공사 호출 0콜로 그린다 — 서버 조회를 부르지 않는다.

import { DWELL_MINUTES_SEED, INDOOR_OUTDOOR_SEED, LCLS_SYSTM2, type IndoorOutdoor } from "@tourlint/shared";

const SCROLL = "max-h-80 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800";
const IO_LABEL: Record<IndoorOutdoor, string> = { INDOOR: "실내", OUTDOOR: "야외", MIXED: "혼재" };

function nameOf(lcls2: string): string {
  return LCLS_SYSTM2[lcls2]?.name ?? lcls2;
}

export function DwellTable() {
  const rows = Object.entries(DWELL_MINUTES_SEED).sort(([a], [b]) => a.localeCompare(b));
  return (
    <>
      <p className="mb-2 text-xs text-slate-400">종료 시각이 없는 항목의 체류시간을 중분류별로 보완합니다 (분). 표준 값입니다.</p>
      <div className={SCROLL}>
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
            <tr>
              <th className="p-2 font-medium">중분류</th>
              <th className="p-2 font-medium">체류시간(분)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([lcls2, minutes]) => (
              <tr key={lcls2} className="border-t border-slate-100 dark:border-slate-800/60">
                <td className="p-2 text-slate-700 dark:text-slate-200">
                  {nameOf(lcls2)} <span className="text-xs text-slate-400">{lcls2}</span>
                </td>
                <td className="p-2 tabular-nums text-slate-700 dark:text-slate-200">{minutes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function IndoorOutdoorTable() {
  const rows = Object.entries(INDOOR_OUTDOOR_SEED).sort(([a], [b]) => a.localeCompare(b));
  return (
    <>
      <p className="mb-2 text-xs text-slate-400">중분류가 실내인지 야외인지 지정합니다. R09 야외 비중 판정에 쓰입니다. 표준 값입니다.</p>
      <div className={SCROLL}>
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
            <tr>
              <th className="p-2 font-medium">중분류</th>
              <th className="p-2 font-medium">실내 · 야외</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([lcls2, space]) => (
              <tr key={lcls2} className="border-t border-slate-100 dark:border-slate-800/60">
                <td className="p-2 text-slate-700 dark:text-slate-200">
                  {nameOf(lcls2)} <span className="text-xs text-slate-400">{lcls2}</span>
                </td>
                <td className="p-2 text-slate-700 dark:text-slate-200">{IO_LABEL[space]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
