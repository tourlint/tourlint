"use client";

// R10 기대 콘텐츠 프로파일 — 읽기 전용 (UI-S8-005 · FR-OP-021). 타깃 · 콘셉트별로 자주 넣는
// 중분류와 저녁 일정 유무를 정한 표준 63행이다. 모든 계정에 같아 편집하지 않고, 값은
// @tourlint/shared 시드를 그대로 읽는다 — 공사 호출 0콜.

import { CONCEPT_LABEL, LCLS_SYSTM2, TARGET_LABEL, TARGET_PROFILE_SEED } from "@tourlint/shared";

const SCROLL = "max-h-96 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800";

function nameOf(lcls2: string): string {
  return LCLS_SYSTM2[lcls2]?.name ?? lcls2;
}

export function ProfileEditor() {
  return (
    <>
      <p className="mb-2 text-xs text-slate-400">
        타깃 · 콘셉트별로 자주 넣는 종류와 저녁 일정 유무입니다. R10 상품 구성 판정에 쓰이는 표준 값입니다.
      </p>
      <div className={SCROLL}>
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
            <tr>
              <th className="p-2 font-medium">타깃</th>
              <th className="p-2 font-medium">콘셉트</th>
              <th className="p-2 font-medium">자주 넣는 종류</th>
              <th className="p-2 font-medium">저녁 일정</th>
            </tr>
          </thead>
          <tbody>
            {TARGET_PROFILE_SEED.map((p) => (
              <tr key={`${p.targetKey}-${p.conceptKey}`} className="border-t border-slate-100 dark:border-slate-800/60">
                <td className="p-2 text-slate-700 dark:text-slate-200">{TARGET_LABEL[p.targetKey]}</td>
                <td className="p-2 text-slate-700 dark:text-slate-200">{CONCEPT_LABEL[p.conceptKey]}</td>
                <td className="p-2 text-slate-600 dark:text-slate-300">
                  {p.expectedLcls2.map((c) => nameOf(c)).join(" · ")}
                </td>
                <td className="p-2 text-slate-600 dark:text-slate-300">{p.expectsNight ? "있음" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
