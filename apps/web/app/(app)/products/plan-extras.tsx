"use client";

// 장소 담기 아래 행사 · 공연과 걷기 길 칸 (FR-PL-014 · 015 · UI-S2-041 · 048). 기획 화면과 등록 · 편집
// 화면이 같은 카드 · 규칙으로 쓴다 — 다른 것은 넣는 방식뿐이다. 기획 화면은 상품을 바로 고치고
// (출발일 옮기기 · 그 날 끝에 걷기 길), 등록 · 편집 화면은 폼만 바꾼다(출발일 칸 · 일차와 넣을 위치).
// 행사의 겹침은 참고 표시일 뿐 판정은 검수의 몫이다.

import { useEffect, useState } from "react";
import { planApi, type PlanEvent, type PlanWalk } from "../../lib/api";
import { InsertForm } from "./new/insert-form";
import type { Nights, Schedule } from "./new/types";

const RELATION_LABEL: Record<PlanEvent["relation"], string> = {
  IN: "여행 날짜와 겹쳐요",
  BEFORE: "여행 전에 끝나요",
  AFTER: "여행 뒤에 열려요",
};

/**
 * 행사 · 공연. 0건이면 칸을 숨기지 않고 한 줄로 적고(출발일 옮기기 없음), 못 받았으면 따로 적는다
 * (EX-PL-002). 「출발일을 MM월 DD일로」 는 `onMoveStart` 가 받는다 — 항목 시각은 바꾸지 않는다.
 */
export function EventsSection({ regnCd, signguCd, startDate, nights, onMoveStart }: {
  regnCd: string;
  signguCd: string | null;
  startDate: string;
  nights: number;
  onMoveStart: (date: string) => Promise<void> | void;
}) {
  const [events, setEvents] = useState<PlanEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await planApi.events({ regnCd, signguCd, startDate, nights });
        if (alive) { setEvents(res.items); setFailed(false); }
      } catch {
        // 0건과 다르다 — 없다고 적지 않는다
        if (alive) { setEvents(null); setFailed(true); }
      }
    })();
    return () => {
      alive = false;
    };
  }, [regnCd, signguCd, startDate, nights]);

  async function moveStart(date: string) {
    setBusy(true);
    try {
      await onMoveStart(date);
    } finally {
      setBusy(false);
    }
  }

  if (events === null && !failed) return null;
  return (
    <div className="mt-6 border-t border-slate-200 pt-4 dark:border-slate-800">
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">행사 · 공연</h3>
      {failed || events === null ? (
        <p className="mt-1 text-xs text-slate-400">지금은 볼 수 없어요</p>
      ) : events.length === 0 ? (
        <p className="mt-1 text-xs text-slate-400">여행 날짜 앞뒤 3일에 등록된 행사가 없어요</p>
      ) : (
      <ul className="mt-2 space-y-2">
        {events.map((e) => (
          <li key={e.contentId} className="rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-800">
            <p className="font-medium text-slate-800 dark:text-slate-100">{e.title}</p>
            <p className="mt-0.5 text-xs text-slate-400">{e.eventStart} ~ {e.eventEnd} · {RELATION_LABEL[e.relation]}</p>
            {e.suggestedStartDate !== null && (
              <button type="button" onClick={() => void moveStart(e.suggestedStartDate as string)} disabled={busy}
                className="mt-2 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
                출발일을 {Number(e.suggestedStartDate.slice(5, 7))}월 {Number(e.suggestedStartDate.slice(8, 10))}일로
              </button>
            )}
          </li>
        ))}
      </ul>
      )}
    </div>
  );
}

/**
 * 걷기 길 (D9 · FR-PL-015). 넣으면 직접 정한 곳으로 들어간다. 좌표 · 사진이 없어 카드에는 이름 ·
 * 길이 · 걸리는 시간 · 난이도만 있다. 기획 화면은 `onAdd`(넣을 일차 끝), 등록 · 편집 화면은
 * `choose`(일차와 넣을 위치를 고르는 폼 · UI-S2-050)다.
 */
export function WalksSection({ regnCd, signguCd, unavailable = false, onAdd, choose }: {
  regnCd: string;
  signguCd: string | null;
  /** 걷기 길 목록을 못 받았다(briefing 의 walks 가 null) — 그 칸만 「지금은 볼 수 없어요」 */
  unavailable?: boolean;
  onAdd?: (walk: PlanWalk) => Promise<void>;
  choose?: { nights: Nights; schedule: Schedule; onInsert: (walk: PlanWalk, dayIdx: number, insertAt: number) => void };
}) {
  const [walks, setWalks] = useState<PlanWalk[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // 등록 · 편집 화면에서 넣을 위치 폼을 연 카드
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await planApi.walks({ regnCd, signguCd });
        if (alive) { setWalks(res.items); setFailed(false); }
      } catch {
        if (alive) { setWalks([]); setFailed(true); }
      }
    })();
    return () => {
      alive = false;
    };
  }, [regnCd, signguCd]);

  async function add(walk: PlanWalk) {
    if (onAdd === undefined) return;
    setBusyId(walk.walkId);
    try {
      await onAdd(walk);
    } finally {
      setBusyId(null);
    }
  }

  // 걷기 길 목록을 못 받았으면 그 칸만 「지금은 볼 수 없어요」 — 0곳으로 숨기지 않는다 (UI-S2-043 · EX-PL-004)
  if (unavailable || failed) {
    return (
      <div className="mt-6 border-t border-slate-200 pt-4 dark:border-slate-800">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">걷기 길</h3>
        <p className="mt-0.5 text-xs text-slate-400">지금은 볼 수 없어요</p>
      </div>
    );
  }
  if (walks === null || walks.length === 0) return null;
  return (
    <div className="mt-6 border-t border-slate-200 pt-4 dark:border-slate-800">
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">걷기 길</h3>
      <p className="mt-0.5 text-xs text-slate-400">넣으면 직접 정한 곳으로 들어가요.</p>
      <ul className="mt-2 space-y-2">
        {walks.map((w) => (
          <li key={w.walkId} className="rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-800">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-800 dark:text-slate-100">{w.name}</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {[w.lengthKm !== null ? `${w.lengthKm}km` : null, w.minutes !== null ? `약 ${w.minutes}분` : null, w.level !== null ? `난이도 ${w.level}` : null].filter(Boolean).join(" · ")}
                </p>
              </div>
              {choose !== undefined ? (
                <button type="button" onClick={() => setOpenId((id) => (id === w.walkId ? null : w.walkId))} aria-expanded={openId === w.walkId}
                  className="shrink-0 rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-indigo-500">
                  {openId === w.walkId ? "닫기" : "일정에 넣기"}
                </button>
              ) : (
                <button type="button" onClick={() => void add(w)} disabled={busyId === w.walkId}
                  className="shrink-0 rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-60">
                  일정에 넣기
                </button>
              )}
            </div>
            {choose !== undefined && openId === w.walkId && (
              <InsertForm nights={choose.nights} schedule={choose.schedule} onConfirm={(dayIdx, insertAt) => {
                choose.onInsert(w, dayIdx, insertAt);
                setOpenId(null);
              }} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
