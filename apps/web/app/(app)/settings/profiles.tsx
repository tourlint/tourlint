"use client";

// 타깃 · 콘셉트별 기대 구성 — 읽기 전용 (UI-S8-008 · FR-OP-021). 7 × 9 칸이고 칸을 누르면 그 조합에 자주
// 넣는 종류가 보인다. 달 표시는 저녁(19:00 이후) 일정을 기대하는 조합이다. 모든 계정에 같은 표준이라
// 편집하지 않고, 값은 @tourlint/shared 시드를 그대로 읽는다 — 공사 호출 0콜.

import { useState } from "react";
import { CONCEPT_KEY, CONCEPT_LABEL, LCLS_SYSTM2, RULE_CONSTANTS, TARGET_KEY, TARGET_LABEL, findProfile } from "@tourlint/shared";

function nameOf(lcls2: string): string {
  return LCLS_SYSTM2[lcls2]?.name ?? lcls2;
}

const NIGHT_FROM = RULE_CONSTANTS.R10_NIGHT_SLOT_FROM;

/** 고른 칸의 정의 한 줄 */
export function profileDefinition(targetKey: string, conceptKey: string): string | null {
  const p = findProfile(targetKey, conceptKey);
  if (p === null) return null;
  const kinds = p.expectedLcls2.map(nameOf).join(" · ");
  const night = p.expectsNight ? ` · ${NIGHT_FROM} 이후 일정` : "";
  return `${kinds}${night}`;
}

export function ProfileGrid() {
  const [picked, setPicked] = useState<{ target: string; concept: string } | null>(null);
  const definition = picked === null ? null : profileDefinition(picked.target, picked.concept);
  return (
    <>
      <p className="mb-2 text-xs text-slate-400">
        상품 구성 판정이 타깃 · 콘셉트마다 기대하는 구성입니다. 칸을 누르면 그 조합에 자주 넣는 종류가 보여요.
        <MoonMark /> 표시는 {NIGHT_FROM} 이후 일정을 기대하는 조합이에요.
      </p>
      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
        <table className="w-full min-w-[640px] text-xs">
          <thead className="bg-slate-50 text-slate-500 dark:bg-slate-900 dark:text-slate-400">
            <tr>
              <th className="p-2 text-left font-medium">타깃 \ 콘셉트</th>
              {CONCEPT_KEY.map((c) => (
                <th key={c} className="p-2 text-center font-medium">{CONCEPT_LABEL[c]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TARGET_KEY.map((t) => (
              <tr key={t} className="border-t border-slate-100 dark:border-slate-800/60">
                <th scope="row" className="whitespace-nowrap p-2 text-left font-medium text-slate-600 dark:text-slate-300">{TARGET_LABEL[t]}</th>
                {CONCEPT_KEY.map((c) => {
                  const p = findProfile(t, c);
                  const active = picked?.target === t && picked.concept === c;
                  return (
                    <td key={c} className="p-1 text-center">
                      <button
                        type="button"
                        onClick={() => setPicked(active ? null : { target: t, concept: c })}
                        aria-pressed={active}
                        aria-label={`${TARGET_LABEL[t]} · ${CONCEPT_LABEL[c]}`}
                        className={`inline-flex w-full items-center justify-center gap-1 rounded-md px-1.5 py-1 tabular-nums transition ${
                          active
                            ? "bg-indigo-600 text-white"
                            : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                        }`}
                        data-profile-cell
                      >
                        {p === null ? "—" : `${p.expectedLcls2.length}종`}
                        {p?.expectsNight === true && <MoonMark />}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 min-h-5 text-sm text-slate-700 dark:text-slate-200" role="status" data-profile-definition>
        {picked !== null && definition !== null && (
          <>
            <span className="font-medium">{TARGET_LABEL[picked.target as keyof typeof TARGET_LABEL]} · {CONCEPT_LABEL[picked.concept as keyof typeof CONCEPT_LABEL]}</span>
            <span className="ml-1.5">— 자주 넣는 종류: {definition}</span>
          </>
        )}
      </p>
    </>
  );
}

/** 저녁 일정을 기대하는 조합 표시 */
function MoonMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-label="저녁 일정 기대" role="img" className="inline-block align-[-1px]">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
}
