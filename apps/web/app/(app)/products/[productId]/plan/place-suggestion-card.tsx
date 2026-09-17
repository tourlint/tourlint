"use client";

// 기획 에이전트 카드 (FR-AG-010~012 · UI-S2-044~046). 아직 고르지 않은 줄의 장소를 한 번에
// 찾아 준 결과를 보여 준다. 판정하지 않는다 — 고르는 것은 사람이 [이곳으로 선택]을 누른다.

import { useState } from "react";
import { isApiError, matchApi, type PlaceSuggestions } from "../../../../lib/api";

export function PlaceSuggestionCard({
  suggestions,
  onResolved,
}: {
  suggestions: PlaceSuggestions;
  onResolved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const { found, notFound, noName } = suggestions.summary;
  const foundItems = suggestions.items.filter((s) => s.kind === "FOUND" && s.place !== null);

  const summaryParts: string[] = [];
  if (found > 0) summaryParts.push(`${found}곳을 찾았어요`);
  if (notFound > 0) summaryParts.push(`${notFound}곳은 못 찾았어요`);
  if (noName > 0) summaryParts.push(`${noName}곳은 장소 이름이 없어요`);

  async function pickAllFound() {
    setBusy(true);
    setErr(null);
    try {
      for (const s of foundItems) {
        if (s.place !== null) await matchApi.match(s.itemId, s.place.contentId, "AGENT");
      }
      await onResolved();
    } catch (e) {
      setErr(isApiError(e) ? e.message : "선택하지 못했어요.");
      setBusy(false);
    }
  }

  async function pickOne(itemId: number, contentId: string) {
    setBusy(true);
    setErr(null);
    try {
      await matchApi.match(itemId, contentId, "AGENT");
      await onResolved();
    } catch (e) {
      setErr(isApiError(e) ? e.message : "선택하지 못했어요.");
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-indigo-200 bg-indigo-50/40 p-3 dark:border-indigo-900 dark:bg-indigo-950/20">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{summaryParts.join(" · ") || "결과가 없어요"}</p>
        {foundItems.length > 0 && (
          <button
            type="button"
            onClick={() => void pickAllFound()}
            disabled={busy}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-60"
          >
            찾은 {foundItems.length}곳 모두 선택
          </button>
        )}
      </div>
      {err && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{err}</p>}
      {suggestions.incomplete && (
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">일부만 찾았어요. 잠시 후 다시 시도해 주세요.</p>
      )}

      <ul className="mt-2 space-y-2">
        {suggestions.items.map((s) => (
          <li key={s.itemId} className="rounded-lg border border-slate-200 bg-white p-2.5 text-sm dark:border-slate-800 dark:bg-slate-900">
            {s.kind === "FOUND" && s.place !== null ? (
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-medium text-slate-800 dark:text-slate-100">{s.place.title}</span>
                  <span className="ml-2 text-xs text-slate-400">{s.place.kindName}</span>
                  {s.reason !== "" && <p className="text-xs text-slate-400">{s.reason}</p>}
                </div>
                <button
                  type="button"
                  onClick={() => void pickOne(s.itemId, s.place!.contentId)}
                  disabled={busy}
                  className="shrink-0 rounded-md border border-indigo-300 px-2.5 py-1 text-xs font-medium text-indigo-600 transition hover:bg-indigo-50 disabled:opacity-60 dark:border-indigo-800 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
                >
                  이곳으로 선택
                </button>
              </div>
            ) : (
              <p className="text-slate-500 dark:text-slate-400">
                {s.kind === "NO_NAME" ? "장소 이름이 없어요" : "찾지 못했어요"}
                {s.reason !== "" && ` · ${s.reason}`}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
