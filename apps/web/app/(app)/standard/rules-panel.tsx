"use client";

// 규칙 설명 (FR-OP-025 · UI-S8). 규칙을 끄고 켜는 수단은 없다 (PM-NG-003) — 읽기만 한다.
// 쓰는 데이터는 코드(KTO·KAKAO) 대신 사용자 말로 적는다. ?rule=R07 로 들어오면 그 규칙을 편다.

import { useEffect, useState } from "react";
import { auditApi, isApiError, type RuleView } from "../../lib/api";

// 규칙이 쓰는 데이터를 사용자 말로. R08=관광정보+이동 시간, R09=관광정보+날씨 예보 (FR-OP-025).
const DATA_SOURCE_LABEL: Record<string, string> = {
  KTO: "관광정보",
  ITINERARY: "일정",
  KAKAO: "이동 시간",
  KMA: "날씨 예보",
};

function dataSourceText(codes: string[]): string {
  return codes.map((c) => DATA_SOURCE_LABEL[c] ?? c).join(" + ");
}

export function RulesPanel() {
  const [rules, setRules] = useState<RuleView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 규칙 설명 보기 딥링크(?rule=R07). 한 번만 읽는다 — 목록이 뜨기 전 화면은 "불러오는 중…"
  // 이라 서버 · 클라이언트 첫 렌더가 같아 하이드레이션이 어긋나지 않는다.
  const [open, setOpen] = useState<string | null>(() =>
    typeof window === "undefined" ? null : (new URLSearchParams(window.location.search).get("rule")?.toUpperCase() ?? null),
  );

  useEffect(() => {
    let alive = true;
    auditApi
      .rules()
      .then((r) => {
        if (alive) setRules(r.rules);
      })
      .catch((e) => {
        if (alive) setError(isApiError(e) ? e.message : "규칙을 불러오지 못했습니다.");
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>;
  if (rules === null) return <p className="text-sm text-slate-400">불러오는 중…</p>;

  return (
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800/60 dark:border-slate-800">
      {rules.map((r) => {
        const isOpen = open === r.code;
        return (
          <li key={r.code}>
            <button
              type="button"
              onClick={() => setOpen(isOpen ? null : r.code)}
              aria-expanded={isOpen}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition hover:bg-slate-50 dark:hover:bg-slate-800/40"
            >
              <span className="font-mono text-xs text-slate-400">{r.code}</span>
              <span className="font-medium text-slate-800 dark:text-slate-100">{r.name}</span>
              {r.companyAdjustable && (
                <span className="ml-1 rounded bg-indigo-50 px-1.5 py-0.5 text-xs font-medium text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300">
                  회사 기준으로 조정 가능
                </span>
              )}
              <span className="ml-auto text-xs text-slate-400">{isOpen ? "접기" : "설명"}</span>
            </button>
            {isOpen && (
              <dl className="space-y-1.5 px-3 pb-3 text-sm">
                <Row label="무엇을 보나">{r.threshold}</Row>
                <Row label="쓰는 데이터">{dataSourceText(r.dataSources)}</Row>
                <Row label="예">{r.example}</Row>
              </dl>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-xs text-slate-400">{label}</dt>
      <dd className="text-slate-600 dark:text-slate-300">{children}</dd>
    </div>
  );
}
