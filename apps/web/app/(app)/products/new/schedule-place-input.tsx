"use client";

// 등록 화면 일정 행의 장소 칸 — 입력하는 순간 목록에서 고르기 (UI-S2-020 · 개편안 4-2 변경 지점 3).
// 장소 칸에 치면 "(지역)에서 찾은 곳"이 드롭다운으로 뜨고(searchKeyword2), 고르면 ✓ 와 함께
// 좌표·분류를 상세(detailCommon2)로 잡아 폼에 담는다. 저장(create)이 CONFIRMED 로 저장한다.
// 못 찾으면 "직접 정한 곳으로 두기" — 매칭 없이 둔다(저장 시 PENDING, /plan 에서 이어 고름).

import { useEffect, useRef, useState } from "react";
import { contentApi, matchApi, type ContentCandidate } from "../../../lib/api";
import type { MatchedContent } from "./types";

const CONTENT_TYPE_LABEL: Record<number, string> = {
  12: "관광지", 14: "문화시설", 15: "축제", 25: "여행코스", 28: "레포츠", 32: "숙박", 38: "쇼핑", 39: "음식점",
};

export function SchedulePlaceInput({
  value,
  content,
  regnCd,
  signguCd,
  regionLabel,
  onChange,
}: {
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
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
        try {
          const res = await matchApi.search(kw, regnCd, signguCd);
          if (alive) { setCandidates(res.candidates); setOpen(true); }
        } catch {
          if (alive) setCandidates([]);
        } finally {
          if (alive) setSearching(false);
        }
      })();
    }, 300);
    return () => { alive = false; window.clearTimeout(id); };
  }, [value, content, regnCd, signguCd]);

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
    setOpen(false);
    setBusy(true);
    // 좌표·분류·유형을 상세로 취득해 폼에 담는다. 못 읽으면 좌표 없이 담는다(저장은 됨)
    let typeId = c.contenttypeid;
    let mapx: number | null = null;
    let mapy: number | null = null;
    let lcls1: string | null = null;
    let lcls2: string | null = null;
    let lcls3: string | null = null;
    try {
      const d = await contentApi.detail(c.contentid);
      typeId = d.contentTypeId ?? typeId;
      mapx = d.mapx;
      mapy = d.mapy;
      lcls1 = d.lclsSystm1;
      lcls2 = d.lclsSystm2;
      lcls3 = d.lclsSystm3;
    } catch {
      // 상세를 못 읽어도 고른 것은 유지한다 — 좌표는 /plan 재매칭에서 채운다
    }
    setBusy(false);
    if (typeId === null) return; // 유형을 모르면 저장이 거부되므로 담지 않는다
    onChange({
      place: c.title ?? value,
      content: { contentId: c.contentid, contentTypeId: typeId, mapx, mapy, lcls1, lcls2, lcls3 },
    });
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
            onClick={() => onChange({ content: null })}
            className="shrink-0 text-xs text-slate-500 underline-offset-2 hover:underline dark:text-slate-400"
          >
            다시 고르기
          </button>
        </div>
      </div>
    );
  }

  const count = candidates?.length ?? 0;

  return (
    <div ref={ref} className="relative flex min-w-[10rem] flex-1 flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
      장소명
      <input
        type="text"
        value={value}
        placeholder="예: 경복궁"
        onFocus={() => candidates !== null && setOpen(true)}
        onChange={(e) => onChange({ place: e.target.value })}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
      />
      {open && value.trim() !== "" && (
        <div className="absolute top-full z-10 mt-1 w-full rounded-lg border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-800 dark:bg-slate-900">
          {searching ? (
            <p className="px-2 py-1.5 text-xs text-slate-400">찾는 중…</p>
          ) : count === 0 ? (
            <p className="px-2 py-1.5 text-xs text-slate-400">관광정보에 올라 있는 이름으로 검색해 보세요</p>
          ) : (
            <>
              <p className="px-2 py-1 text-xs text-slate-400">{regionLabel}에서 찾은 곳 {count}곳</p>
              <ul className="max-h-56 overflow-y-auto">
                {candidates!.map((c) => (
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
            onClick={() => setOpen(false)}
            className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-xs text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            찾는 곳이 없나요? 직접 정한 곳으로 두기
          </button>
        </div>
      )}
    </div>
  );
}
