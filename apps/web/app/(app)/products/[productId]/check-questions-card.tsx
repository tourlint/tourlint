"use client";

// 검수 에이전트 — 전화로 물어볼 내용 정리 (F18 · FR-AG-020~022). 사람이 누를 때만 돌고
// 판정하지 않는다. 곳마다 방문 날짜 · 시각 · 전화번호와 물어볼 질문을 보여 주고, 확인은
// 기존 [확인했어요](직접 확인할 곳 목록)로 한다.

import { useState } from "react";
import { agentApi, isApiError, type CheckQuestionPlace } from "../../../lib/api";

export function CheckQuestionsCard({
  runId,
  itemLabel,
}: {
  runId: number;
  itemLabel: (itemId: number | null) => string;
}) {
  const [places, setPlaces] = useState<CheckQuestionPlace[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      const res = await agentApi.checkQuestions(runId);
      setPlaces(res.places);
      setIncomplete(res.incomplete !== null);
    } catch (e) {
      setErr(isApiError(e) ? e.message : "물어볼 내용을 만들지 못했어요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-slate-700 dark:text-slate-200">전화로 물어볼 내용</p>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-60"
        >
          {busy ? "만드는 중…" : "물어볼 내용 만들기"}
        </button>
      </div>
      {err && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{err}</p>}
      {places !== null && (
        <div className="mt-3 space-y-3">
          {places.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">전화로 확인할 곳이 없어요.</p>
          ) : (
            places.map((p) => <PlaceQuestions key={p.itemId} place={p} itemLabel={itemLabel} />)
          )}
          {incomplete && (
            <p className="text-xs text-amber-600 dark:text-amber-400">일부만 정리했어요. 잠시 후 다시 시도해 주세요.</p>
          )}
          {places.length > 0 && (
            <p className="text-xs text-slate-400">확인한 내용에 맞게 일정을 고치면, 다시 검수할 때 반영돼요.</p>
          )}
        </div>
      )}
    </div>
  );
}

function PlaceQuestions({
  place,
  itemLabel,
}: {
  place: CheckQuestionPlace;
  itemLabel: (itemId: number | null) => string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(place.questions.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 클립보드가 막혀 있으면 조용히 둔다 — 질문은 화면에 그대로 있다
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{itemLabel(place.itemId)}</p>
      <p className="mt-0.5 text-xs text-slate-400">
        {place.visit.dayNo}일차 · {place.visit.date}
        {place.visit.start !== null && ` ${place.visit.start}`}
        {" · "}
        {place.tel ?? "등록된 전화번호가 없어요. 지역 관광안내소에 물어보세요."}
      </p>
      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-slate-700 dark:text-slate-200">
        {place.questions.map((q, i) => (
          <li key={i}>{q}</li>
        ))}
      </ul>
      <button
        type="button"
        onClick={copy}
        className="mt-2 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        {copied ? "복사했어요" : "질문 복사"}
      </button>
    </div>
  );
}
