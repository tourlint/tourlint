"use client";

// 아직 고르지 않은 장소 안내와 기획 에이전트 진입 (FR-AG-012 · UI-S2-033 · UI-S2-042). [AI로 한 번에
// 찾기]를 누르면 고르지 않은 줄의 장소를 한 번에 찾아 카드로 보여 준다. 검수 시작 창에서도 같은
// 찾기를 부르므로(UI-S2-023) 결과는 기획 화면이 들고 있다 — `usePlaceFinder`.

import { useCallback, useState } from "react";
import { agentApi, isApiError, type PlaceSuggestions } from "../../../../lib/api";
import { PlaceSuggestionCard } from "./place-suggestion-card";
import type { LineItem } from "./line-label";

/** AI 로 찾지 못했을 때 보일 말. `unavailable` 이면 「지금은 AI로 정리할 수 없어요」 를 머리에 둔다 */
export interface FinderFailure {
  readonly unavailable: boolean;
  readonly reason: string;
}

export interface PlaceFinder {
  readonly suggestions: PlaceSuggestions | null;
  readonly busy: boolean;
  readonly failure: FinderFailure | null;
  readonly findAll: () => Promise<void>;
}

/**
 * 고르지 않은 줄을 AI 로 한 번에 찾는다 (FR-AG-010 · 012).
 *
 * 요청이 거절되면(예산 · 서버 오류 · 네트워크) 카드를 없애지 않고 까닭을 적는다 — 「장소를 찾지
 * 못했어요」 로 적으면 찾아봤는데 없었다는 말이 된다(FR-AG-005 · EX-AG-001). 같은 계정에서 이미
 * 돌고 있으면 서버 말(「이미 정리하고 있어요」)을 그대로 보인다 (EX-AG-004).
 */
export function usePlaceFinder(productId: number): PlaceFinder {
  const [suggestions, setSuggestions] = useState<PlaceSuggestions | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FinderFailure | null>(null);

  const findAll = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      setSuggestions(await agentApi.placeSuggestions(productId));
    } catch (e) {
      setSuggestions(null);
      if (isApiError(e) && e.reasonCode === "RATE_LIMIT_EXCEEDED") setFailure({ unavailable: false, reason: e.message });
      else setFailure({ unavailable: true, reason: isApiError(e) ? e.message : "잠시 후 다시 눌러 주세요." });
    } finally {
      setBusy(false);
    }
  }, [productId]);

  return { suggestions, busy, failure, findAll };
}

export function PendingBar({
  pendingCount,
  finder,
  items = [],
  regnCd = "",
  signguCd = null,
  regionLabel = "이 지역",
  onResolved,
}: {
  pendingCount: number;
  finder: PlaceFinder;
  /** 일정 줄 — 일차가 붙어 있으면 카드 줄마다 「1일차 09:00 · 강릉역」 으로 적는다 */
  items?: readonly LineItem[];
  regnCd?: string;
  signguCd?: string | null;
  regionLabel?: string;
  onResolved: () => Promise<void>;
}) {
  if (pendingCount === 0) return null;
  const { suggestions, busy, failure, findAll } = finder;

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
      {failure !== null && (
        <div role="status" className="mt-3 rounded-xl border border-indigo-200 bg-indigo-50/40 p-3 text-sm dark:border-indigo-900 dark:bg-indigo-950/20">
          {failure.unavailable && <p className="font-medium text-slate-700 dark:text-slate-200">지금은 AI로 정리할 수 없어요</p>}
          <p className="text-slate-600 dark:text-slate-300">{failure.reason}</p>
          {failure.unavailable && (
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">장소 찾기나 직접 정한 곳으로 두기는 그대로 쓸 수 있어요.</p>
          )}
        </div>
      )}
      {suggestions !== null && (
        <PlaceSuggestionCard
          suggestions={suggestions}
          items={items}
          regnCd={regnCd}
          signguCd={signguCd}
          regionLabel={regionLabel}
          onResolved={onResolved} // 고른 줄은 카드가 항목 목록을 보고 스스로 뺀다 — 찾은 다른 후보는 남는다 (#763)
        />
      )}
    </div>
  );
}
