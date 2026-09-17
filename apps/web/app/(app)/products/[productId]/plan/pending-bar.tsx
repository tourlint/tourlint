"use client";

// 아직 고르지 않은 장소 안내와 기획 에이전트 진입 (FR-AG-012 · UI-S2-042). [AI로 한 번에
// 찾기]를 누르면 고르지 않은 줄의 장소를 한 번에 찾아 카드로 보여 준다.

import { useState } from "react";
import { agentApi, isApiError, type PlaceSuggestions, type ProductItem } from "../../../../lib/api";
import { PlaceSuggestionCard } from "./place-suggestion-card";

export function PendingBar({
  productId,
  pendingCount,
  items = [],
  regnCd = "",
  signguCd = null,
  regionLabel = "이 지역",
  onResolved,
}: {
  productId: number;
  pendingCount: number;
  items?: ProductItem[];
  regnCd?: string;
  signguCd?: string | null;
  regionLabel?: string;
  onResolved: () => Promise<void>;
}) {
  const [suggestions, setSuggestions] = useState<PlaceSuggestions | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function findAll() {
    setBusy(true);
    setErr(null);
    try {
      setSuggestions(await agentApi.placeSuggestions(productId));
    } catch (e) {
      setErr(isApiError(e) ? e.message : "장소를 찾지 못했어요.");
    } finally {
      setBusy(false);
    }
  }

  if (pendingCount === 0) return null;

  return (
    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-amber-800 dark:text-amber-300">
          아직 고르지 않은 장소 {pendingCount}곳 · 고르면 이용시간과 쉬는 날이 보여요
        </p>
        <button
          type="button"
          onClick={() => void findAll()}
          disabled={busy}
          className="shrink-0 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-60"
        >
          {busy ? "찾는 중…" : "AI로 한 번에 찾기"}
        </button>
      </div>
      {err && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{err}</p>}
      {suggestions !== null && (
        <PlaceSuggestionCard
          suggestions={suggestions}
          items={items}
          regnCd={regnCd}
          signguCd={signguCd}
          regionLabel={regionLabel}
          onResolved={async () => {
            await onResolved();
            setSuggestions(null); // 고른 뒤 다시 목록에서 확인한다
          }}
        />
      )}
    </div>
  );
}
