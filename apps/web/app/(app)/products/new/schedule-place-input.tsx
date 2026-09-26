"use client";

// 등록 화면 일정 행의 장소 칸 — 입력하는 순간 목록에서 고르기 (UI-S2-020 · 개편안 4-2 변경 지점 3).
// 장소 칸에 치면 "(지역)에서 찾은 곳"이 드롭다운으로 뜨고(searchKeyword2), 고르면 ✓ 와 함께
// 좌표·분류를 상세(detailCommon2)로 잡아 폼에 담는다. 저장(create)이 CONFIRMED 로 저장한다.
// 못 찾으면 "직접 정한 곳으로 두기" — 매칭 없이 둔다(저장 시 PENDING, /plan 에서 이어 고름).

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { contentApi, type ContentCandidate } from "../../../lib/api";
import { canAnchor, searchSchedulePlaces } from "./schedule-place-search";
import type { MatchedContent } from "./types";

const CONTENT_TYPE_LABEL: Record<number, string> = {
  12: "관광지", 14: "문화시설", 15: "축제", 25: "여행코스", 28: "레포츠", 32: "숙박", 38: "쇼핑", 39: "음식점",
};

export interface PlaceInputHandle { chooseAsAnchor(): void }

export function SchedulePlaceInput({
  ref: handleRef,
  onAnchorReady,
  value,
  content,
  regnCd,
  signguCd,
  regionLabel,
  onChange,
}: {
  ref?: Ref<PlaceInputHandle>;
  onAnchorReady?: () => void;
  value: string;
  content: MatchedContent | null;
  regnCd: string;
  signguCd: string | null;
  regionLabel: string;
  onChange: (patch: { place?: string; content?: MatchedContent | null }) => void;
}) {
  const [candidates, setCandidates] = useState<ContentCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [pendingPick, setPendingPick] = useState<{ key: string; ticket: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pickSeq = useRef(0);
  const anchorIntent = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // 검색 호출 자체가 실패한 조회 — 0곳과 다르다. 줄은 고르지 않은 채로 두고 다시 시도를 준다 (EX-MC-004)
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [resultKey, setResultKey] = useState("");
  const [searchVersion, setSearchVersion] = useState(0);
  const lookupKey = JSON.stringify([value, regnCd, signguCd, content?.contentId]);
  const busy = pendingPick?.key === lookupKey;

  // 조회 중 행이 편집·삭제·재변환되면 오래된 결과를 적용하지 않는다.
  useEffect(() => () => { pickSeq.current += 1; anchorIntent.current = false; }, [value, content, regnCd, signguCd]);

  function openSearch(asAnchor: boolean) {
    anchorIntent.current = asAnchor;
    setOpen(true);
    if (candidates === null) setSearchVersion((version) => version + 1);
    setError(regnCd === "" ? "먼저 기본정보에서 여행 지역을 선택해 주세요."
      : value.trim() === "" ? "기준으로 삼을 장소명을 입력해 주세요." : null);
    inputRef.current?.focus();
  }

  useImperativeHandle(handleRef, () => ({
    chooseAsAnchor() {
      if (busy) return;
      anchorIntent.current = true;
      if (content !== null) {
        void pick({ contentid: content.contentId, contenttypeid: content.contentTypeId,
          title: value, addr1: null, cpyrhtDivCd: null });
      } else openSearch(true);
    },
  }));

  // 고른 상태가 아니고 입력이 있으면 검색한다 (디바운스 300ms). 지역이 없으면 검색하지 않는다
  useEffect(() => {
    if (content !== null) return;
    const kw = value.trim();
    let alive = true;
    const id = window.setTimeout(() => {
      void (async () => {
        if (kw === "" || regnCd === "") {
          if (alive) { setCandidates(null); setSearching(false); }
          return;
        }
        setSearching(true);
        setError(null);
        setFailedKey(null);
        try {
          const res = await searchSchedulePlaces(kw, regnCd, signguCd, regionLabel);
          if (alive) { setCandidates(res.candidates); setResultKey(lookupKey); }
        } catch {
          // 0곳으로 적지 않는다 — 목록 자리에 실패와 다시 시도를 둔다 (EX-MC-004)
          if (alive) { setCandidates(null); setFailedKey(lookupKey); }
        } finally {
          if (alive) setSearching(false);
        }
      })();
    }, 300);
    return () => { alive = false; window.clearTimeout(id); };
  }, [value, content, regnCd, signguCd, regionLabel, lookupKey, searchVersion]);

  // 목록 밖을 누르면 드롭다운을 닫는다 (UI-CM-042)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  async function pick(c: ContentCandidate): Promise<void> {
    const ticket = ++pickSeq.current;
    const shouldAnchor = anchorIntent.current;
    setPendingPick({ key: lookupKey, ticket });
    setError(null);
    try {
      const d = await contentApi.detail(c.contentid);
      if (ticket !== pickSeq.current) return;
      const typeId = d.contentTypeId ?? c.contenttypeid;
      if (typeId === null) { setError("장소 유형을 확인하지 못했습니다. 다시 선택해 주세요."); return; }
      const matched: MatchedContent = { contentId: c.contentid, contentTypeId: typeId,
        mapx: d.mapx, mapy: d.mapy, lcls1: d.lclsSystm1, lcls2: d.lclsSystm2, lcls3: d.lclsSystm3 };
      onChange({ place: c.title ?? value, content: matched });
      setOpen(false);
      if (!canAnchor(matched)) setError("이 장소는 좌표가 없어 근처 검색의 기준으로 사용할 수 없어요. 다른 장소를 골라 주세요.");
      else if (shouldAnchor) onAnchorReady?.();
    } catch {
      if (ticket === pickSeq.current) setError("장소 정보를 불러오지 못했습니다. 다시 선택해 주세요.");
    } finally {
      setPendingPick((current) => current?.ticket === ticket ? null : current);
    }
  }

  // 고른 상태 — ✓ 와 다시 고르기
  if (content !== null) {
    return (
      <div className="flex min-w-[10rem] flex-1 flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
        장소명
        <div className="flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 dark:border-emerald-800 dark:bg-emerald-950/40">
          <span className="text-emerald-600 dark:text-emerald-400">✓</span>
          <span className="min-w-0 flex-1 truncate text-sm text-slate-800 dark:text-slate-100">{value}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => { setError(null); onChange({ content: null }); }}
            className="shrink-0 text-xs text-slate-500 underline-offset-2 hover:underline dark:text-slate-400"
          >
            다시 고르기
          </button>
        </div>
        {!canAnchor(content) && <span>좌표 확인이 필요해요. 기준을 눌러 다시 확인할 수 있습니다.</span>}
        {busy && <span role="status">장소 확인 중…</span>}
        {error && <span role="alert" className="text-rose-600">{error}</span>}
      </div>
    );
  }

  const currentCandidates = resultKey === lookupKey ? candidates : null;
  const count = currentCandidates?.length ?? 0;
  const failed = failedKey === lookupKey;

  return (
    <div ref={ref} className="relative flex min-w-[10rem] flex-1 flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
      장소명
      <input
        ref={inputRef}
        type="text"
        aria-label="장소명"
        value={value}
        placeholder="예: 경복궁"
        onFocus={() => setOpen(true)}
        onChange={(e) => { pickSeq.current += 1; setPendingPick(null); onChange({ place: e.target.value }); }}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
      />
      <button type="button" disabled={busy} onClick={() => openSearch(false)} className="self-start text-xs font-medium text-emerald-700 underline underline-offset-2 disabled:opacity-50">
        {busy ? "장소 확인 중…" : "장소 확인"}
      </button>
      {error && <span role="alert" className="text-rose-600">{error}</span>}
      {open && value.trim() !== "" && regnCd !== "" && (
        <div className="absolute top-full z-10 mt-1 w-full rounded-lg border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-800 dark:bg-slate-900">
          {failed && !searching ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-xs text-slate-500 dark:text-slate-400">
              <span>장소를 검색하지 못했어요.</span>
              <button
                type="button"
                onClick={() => setSearchVersion((version) => version + 1)}
                className="rounded-md border border-slate-300 px-2 py-0.5 font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                다시 시도
              </button>
            </div>
          ) : searching || (currentCandidates === null && error === null) ? (
            <p className="px-2 py-1.5 text-xs text-slate-400">찾는 중…</p>
          ) : count === 0 ? (
            // 숫자 대신 다음에 할 일 (EX-PL-010 · UI-CM-043)
            <p className="px-2 py-1.5 text-xs text-slate-400">관광정보에 올라 있는 이름으로 검색해 보세요</p>
          ) : (
            <>
              <p className="px-2 py-1 text-xs text-slate-400">{regionLabel}에서 찾은 곳 {count}곳</p>
              <ul className="max-h-56 overflow-y-auto">
                {currentCandidates!.map((c) => (
                  <li key={c.contentid}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void pick(c)}
                      className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left transition hover:bg-slate-100 disabled:opacity-60 dark:hover:bg-slate-800"
                    >
                      <span className="text-sm text-slate-800 dark:text-slate-100">
                        {c.title}
                        {c.contenttypeid !== null && (
                          <span className="ml-2 text-xs text-slate-400">{CONTENT_TYPE_LABEL[c.contenttypeid] ?? ""}</span>
                        )}
                      </span>
                      {c.addr1 !== null && <span className="truncate text-xs text-slate-400">{c.addr1}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <button
            type="button"
            onClick={() => { anchorIntent.current = false; setOpen(false); }}
            className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-xs text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            찾는 곳이 없나요? 직접 정한 곳으로 두기
          </button>
        </div>
      )}
    </div>
  );
}
