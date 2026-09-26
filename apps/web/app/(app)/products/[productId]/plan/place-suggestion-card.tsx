"use client";

// 기획 에이전트 카드 (FR-AG-010~012 · UI-S2-044~046). 아직 고르지 않은 줄의 장소를 한 번에
// 찾아 준 결과를 보여 준다. 판정하지 않는다 — 고르는 것은 사람이 [이곳으로 선택]을 누른다.
// 카드가 다루는 줄은 편집기 줄의 [장소 찾기] · [직접 정한 곳으로 두기]를 숨기므로(UI-S2-034)
// 같은 동작을 카드 버튼으로 모두 둔다.

import { useEffect, useRef, useState } from "react";
import { isApiError, matchApi, type PlaceSuggestions, type ProductItem } from "../../../../lib/api";
import { PlaceAutocomplete } from "./place-autocomplete";

/** 끝나지 않은 까닭을 사람 말로 (FR-AG-005 · EX-AG-001). 내부 코드는 적지 않는다 */
export function unfinishedReason(reasonCode: string): string {
  return reasonCode === "BUDGET_EXHAUSTED"
    ? "오늘 쓸 수 있는 관광정보 조회를 다 써서 끝까지 찾지 못했어요."
    : "AI 응답을 제때 받지 못했어요.";
}

/**
 * 카드가 지금 다루는 줄 — 응답에 있고 아직 고르지 않은 줄 (UI-S2-034). 편집기가 이 줄의 두 버튼을
 * 숨긴다. 끝나지 않아 응답에 없는 줄은 편집기에서 그대로 고른다 (EX-AG-002).
 */
export function cardItemIds(suggestions: PlaceSuggestions | null, items: readonly ProductItem[]): ReadonlySet<number> {
  if (suggestions === null) return new Set();
  const pending = new Set(items.filter((it) => it.matchStatus === "PENDING").map((it) => it.itemId));
  return new Set(suggestions.items.map((s) => s.itemId).filter((id) => pending.has(id)));
}

export function PlaceSuggestionCard({
  suggestions,
  items = [],
  regnCd = "",
  signguCd = null,
  regionLabel = "이 지역",
  onResolved,
}: {
  suggestions: PlaceSuggestions;
  items?: ProductItem[];
  regnCd?: string;
  signguCd?: string | null;
  regionLabel?: string;
  onResolved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // [장소 찾기]로 연 줄 — 그 줄 칸에서 직접 찾는다. 목록 밖을 누르면 카드로 돌아온다 (UI-CM-042)
  const [searchItemId, setSearchItemId] = useState<number | null>(null);
  const itemOf = (itemId: number): ProductItem | undefined => items.find((it) => it.itemId === itemId);

  // 고른 줄(고른 곳 · 직접 정한 곳)은 카드에서 뺀다. 응답 시점의 목록을 그대로 두면 위 안내가 「1곳」 인데
  // 카드는 「2곳은 못 찾았어요」 로 남는다 (#763). 항목 목록이 없으면(목록 밖) 응답 그대로 그린다.
  const rows = items.length === 0
    ? suggestions.items
    : suggestions.items.filter((s) => itemOf(s.itemId)?.matchStatus === "PENDING");
  const found = rows.filter((s) => s.kind === "FOUND").length;
  const notFound = rows.filter((s) => s.kind === "NOT_FOUND").length;
  const noName = rows.filter((s) => s.kind === "NO_NAME").length;
  const foundItems = rows.filter((s) => s.kind === "FOUND" && s.place !== null);

  // 실패 · 시간 초과 · 예산으로 끝나지 않은 줄이 아직 남았으면 까닭을 적는다 (FR-AG-005 · EX-AG-001).
  // 끝나지 않은 줄은 결과를 붙이지 않고 편집기에서 사람이 고른다 (EX-AG-002)
  const unfinished = suggestions.incomplete === null ? null
    : items.length === 0 || suggestions.incomplete.itemIds.some((id) => itemOf(id)?.matchStatus === "PENDING")
      ? suggestions.incomplete : null;

  const summaryParts: string[] = [];
  if (found > 0) summaryParts.push(`${found}곳을 찾았어요`);
  if (notFound > 0) summaryParts.push(`${notFound}곳은 못 찾았어요`);
  if (noName > 0) summaryParts.push(`${noName}곳은 장소 이름이 없어요`);

  // 하나를 고른 뒤에도 카드는 남는다 — 남은 줄의 버튼을 잠근 채 두지 않는다
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
    } finally {
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
    } finally {
      setBusy(false);
    }
  }

  // 편집기 줄에서 숨긴 [직접 정한 곳으로 두기]를 카드에서 한다 (UI-S2-034 · UI-S2-044)
  async function keepAsIs(itemId: number) {
    setBusy(true);
    setErr(null);
    try {
      await matchApi.exclude(itemId);
      await onResolved();
    } catch (e) {
      setErr(isApiError(e) ? e.message : "처리하지 못했어요.");
    } finally {
      setBusy(false);
    }
  }

  // 다 골랐고 끝나지 않은 줄도 없으면 카드도 끝이다
  if (rows.length === 0 && unfinished === null) return null;

  const findButton = (itemId: number) => itemOf(itemId) !== undefined && (
    <button
      type="button"
      onClick={() => setSearchItemId(itemId)}
      className="shrink-0 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
    >
      장소 찾기
    </button>
  );

  return (
    <div className="mt-3 rounded-xl border border-indigo-200 bg-indigo-50/40 p-3 dark:border-indigo-900 dark:bg-indigo-950/20">
      {rows.length > 0 && (
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
      )}
      {unfinished !== null && (
        <p role="status" className={`${rows.length > 0 ? "mt-1 " : ""}text-sm text-amber-700 dark:text-amber-300`}>
          지금은 AI로 정리할 수 없어요 · {unfinishedReason(unfinished.reasonCode)}
          {rows.length > 0 ? " 끝난 곳만 보여 드려요." : " 장소 찾기나 직접 정한 곳으로 두기는 그대로 쓸 수 있어요."}
        </p>
      )}
      {err && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{err}</p>}

      {rows.length > 0 && (
        <ul className="mt-2 space-y-2">
          {rows.map((s) => {
            const item = itemOf(s.itemId);
            return (
              <li key={s.itemId} className="rounded-lg border border-slate-200 bg-white p-2.5 text-sm dark:border-slate-800 dark:bg-slate-900">
                {searchItemId === s.itemId && item !== undefined ? (
                  // 그 줄 칸에서 직접 찾는다. 글자를 전체 선택한 채 연다. 밖을 누르면 카드로 돌아온다 (UI-S2-045)
                  <InlineSearch onClose={() => setSearchItemId(null)}>
                    <PlaceAutocomplete
                      item={item}
                      regnCd={regnCd}
                      signguCd={signguCd}
                      regionLabel={regionLabel}
                      autoFocus
                      // 이름이 없다고 본 줄은 그 문구로 검색하지 않는다 — 빈 칸과 안내로 연다 (UI-S2-045)
                      {...(s.kind === "NO_NAME" ? { initialKeyword: "" } : {})}
                      onResolved={async () => {
                        setSearchItemId(null);
                        await onResolved();
                      }}
                    />
                  </InlineSearch>
                ) : s.kind === "FOUND" && s.place !== null ? (
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-medium text-slate-800 dark:text-slate-100">{s.place.title}</span>
                      <span className="ml-2 text-xs text-slate-400">{s.place.kindName}</span>
                      {s.reason !== "" && <p className="text-xs text-slate-400">{s.reason}</p>}
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => void pickOne(s.itemId, s.place!.contentId)}
                        disabled={busy}
                        className="shrink-0 rounded-md border border-indigo-300 px-2.5 py-1 text-xs font-medium text-indigo-600 transition hover:bg-indigo-50 disabled:opacity-60 dark:border-indigo-800 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
                      >
                        이곳으로 선택
                      </button>
                      {findButton(s.itemId)}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-slate-500 dark:text-slate-400">
                      {s.kind === "NO_NAME" ? "장소 이름이 없어요" : "찾지 못했어요"}
                      {s.reason !== "" && ` · ${s.reason}`}
                    </p>
                    {/* 그 줄을 열어 직접 찾게 한다 (UI-S2-044). 항목을 못 찾으면(목록 밖) 버튼을 숨긴다 */}
                    <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                      {s.kind === "NOT_FOUND" && item !== undefined && (
                        <button
                          type="button"
                          onClick={() => void keepAsIs(s.itemId)}
                          disabled={busy}
                          className="shrink-0 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                        >
                          직접 정한 곳으로 두기
                        </button>
                      )}
                      {findButton(s.itemId)}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * 줄 칸에서 직접 찾을 때의 바깥클릭 복귀 (UI-CM-042). 목록 밖을 누르면 카드로 돌아온다.
 * 문서 mousedown 을 듣되, 이 칸 안이면 무시한다.
 */
function InlineSearch({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);
  return <div ref={ref}>{children}</div>;
}
