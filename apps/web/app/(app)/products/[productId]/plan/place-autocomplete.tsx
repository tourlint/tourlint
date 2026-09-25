"use client";

// 장소 찾기 (F02 · FR-PL-004 · UI-S2-020~023). 아직 고르지 않은(PENDING) 항목의 이름으로
// 공사 콘텐츠를 찾아 고르거나 직접 정한 곳으로 둔다. 사용자가 친 글은 그대로 두고 공식
// 명칭은 고른 뒤 표시한다 (D1). 결과가 1곳뿐이면 자동으로 고른다(AUTO).
// 이미 고른 곳을 다시 고를 때(FR-IN-029 · #802)는 자동으로 고르지 않는다 — 같은 곳이 바로
// 다시 골라져 다른 곳을 고를 수 없다.

import { useEffect, useRef, useState } from "react";
import { isApiError, itemApi, matchApi, type ContentCandidate, type ProductItem } from "../../../../lib/api";

const CONTENT_TYPE_LABEL: Record<number, string> = {
  12: "관광지", 14: "문화시설", 15: "축제", 25: "여행코스", 28: "레포츠", 32: "숙박", 38: "쇼핑", 39: "음식점",
};

export function PlaceAutocomplete({
  item,
  regnCd,
  signguCd,
  regionLabel,
  onResolved,
  autoPick = true,
  onCancel,
}: {
  item: ProductItem;
  regnCd: string;
  signguCd: string | null;
  regionLabel: string;
  onResolved: () => Promise<void>;
  /** 결과가 1곳이면 자동으로 고른다. 다시 고를 때는 끈다 */
  autoPick?: boolean;
  /** 다시 고르기를 그만둔다 — 있으면 「취소」 가 보인다 */
  onCancel?: () => void;
}) {
  const [keyword, setKeyword] = useState(item.place);
  const [candidates, setCandidates] = useState<ContentCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const autoTried = useRef(false);

  // 이름이 아직 없는 줄 — 빈 검색을 던지지 않고 이름을 적어 보라고 안내한다 (UI-S2-021)
  const emptyName = keyword.trim() === "";

  // 입력이 멈춘 뒤 300ms 에 검색한다 (디바운스). setState 는 비동기 콜백 안에서만.
  useEffect(() => {
    let alive = true;
    const id = window.setTimeout(() => {
      void (async () => {
        // 빈 이름은 검색하지 않는다 — 문구로 안내한다 (이름 없는 줄)
        if (keyword.trim() === "") {
          if (alive) {
            setCandidates(null);
            setSearching(false);
          }
          return;
        }
        setSearching(true);
        setErr(null);
        try {
          const res = await matchApi.search(keyword, regnCd, signguCd);
          if (!alive) return;
          setCandidates(res.candidates);
          // 처음 검색에서 딱 한 곳이면 자동으로 고른다 (1건 자동 · AUTO)
          if (autoPick && !autoTried.current && keyword === item.place && res.candidates.length === 1) {
            autoTried.current = true;
            const only = res.candidates[0];
            if (only !== undefined) {
              await matchApi.match(item.itemId, only.contentid, "AUTO");
              await onResolved();
            }
          }
        } catch (e) {
          if (alive) setErr(isApiError(e) ? e.message : "장소를 찾지 못했어요.");
        } finally {
          if (alive) setSearching(false);
        }
      })();
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, [keyword, regnCd, signguCd, item.itemId, item.place, onResolved, autoPick]);

  async function pick(contentid: string) {
    setBusy(true);
    setErr(null);
    try {
      await matchApi.match(item.itemId, contentid, "USER");
      /*
       * 다시 고르며 다른 이름으로 찾았으면 줄 이름도 그 말로 바꾼다 — 처음 고를 때처럼 사용자가
       * 친 글이다(D1). 안 바꾸면 「강릉 경포대」 줄에 오죽헌 정보가 붙는다. 공사 명칭은 저장하지
       * 않는다(원문 저장 금지 · DR-PR-001) (#802)
       */
      const typed = keyword.trim();
      if (!autoPick && typed !== "" && typed !== item.place) await itemApi.patch(item.itemId, { placeLabel: typed });
      await onResolved();
    } catch (e) {
      setErr(isApiError(e) ? e.message : "고르지 못했어요.");
      setBusy(false);
    }
  }

  async function keepAsIs() {
    setBusy(true);
    setErr(null);
    try {
      await matchApi.exclude(item.itemId);
      await onResolved();
    } catch (e) {
      setErr(isApiError(e) ? e.message : "처리하지 못했어요.");
      setBusy(false);
    }
  }

  const count = candidates?.length ?? 0;

  return (
    <div className="mt-2">
      <input
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        placeholder="숙소·식당 이름을 적어 보세요…"
        className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
      />
      {err && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{err}</p>}

      {/* 이름이 없는 줄은 검색 대신 안내 문구만 보인다 (UI-S2-021) */}
      {emptyName && <p className="mt-2 text-xs text-slate-400">숙소·식당 이름을 적어 보세요…</p>}

      {candidates !== null && (
        count === 0 ? (
          <p className="mt-2 text-xs text-slate-400">
            {searching ? "찾는 중…" : "관광정보에 올라 있는 이름으로 검색해 보세요 · 상호나 공식 이름이면 찾을 수 있어요"}
          </p>
        ) : (
          <>
            <p className="mt-2 text-xs text-slate-400">{regionLabel}에서 찾은 곳 {count}곳</p>
            <ul className="mt-1 space-y-1">
              {candidates.map((c) => (
                <li key={c.contentid} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/50">
                  <div className="min-w-0">
                    <span className="text-sm text-slate-800 dark:text-slate-100">{c.title}</span>
                    {c.contenttypeid !== null && (
                      <span className="ml-2 text-xs text-slate-400">{CONTENT_TYPE_LABEL[c.contenttypeid] ?? ""}</span>
                    )}
                    {c.addr1 !== null && <p className="truncate text-xs text-slate-400">{c.addr1}</p>}
                  </div>
                  <button
                    type="button"
                    onClick={() => void pick(c.contentid)}
                    disabled={busy}
                    className="shrink-0 rounded-md bg-indigo-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-60"
                  >
                    고르기
                  </button>
                </li>
              ))}
            </ul>
          </>
        )
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <button
          type="button"
          onClick={() => void keepAsIs()}
          disabled={busy}
          className="text-xs text-slate-500 underline-offset-2 hover:underline disabled:opacity-60 dark:text-slate-400"
        >
          찾는 곳이 없나요? 직접 정한 곳으로 두기
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="text-xs text-slate-500 underline-offset-2 hover:underline disabled:opacity-60 dark:text-slate-400"
          >
            취소
          </button>
        )}
      </div>
    </div>
  );
}
