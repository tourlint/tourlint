"use client";

// 검수 에이전트 — 전화로 물어볼 내용 정리 (F18 · FR-AG-020~022 · UI-S3-036 · 037). 사람이 누를
// 때만 돌고 판정하지 않는다. 곳마다 방문 날짜 · 시각 · 전화번호와 물어볼 질문을 보여 주고,
// [확인했어요]는 아래 직접 확인할 곳 목록과 같은 확인 API 를 부른다 — 점수는 그대로다.

import { useState } from "react";
import {
  agentApi, auditApi, isApiError,
  type CheckQuestionPlace, type CheckQuestions, type UnverifiedItem,
} from "../../../lib/api";
import { SourceBadge } from "../../../components/badges";

/** 에이전트를 못 쓴 까닭 — 사유코드를 그대로 적지 않는다 (EX-AG-001 · UI-CM-040) */
const INCOMPLETE_REASON: Record<string, string> = {
  LLM_UNAVAILABLE: "AI가 지금 응답하지 않아요.",
  BUDGET_EXHAUSTED: "오늘 쓸 수 있는 관광정보 조회를 모두 썼어요.",
};

/** 「지금은 AI로 정리할 수 없어요」 뒤에 붙일 까닭 한 줄 (FR-AG-005) */
export function incompleteReasonText(reasonCode: string): string {
  return INCOMPLETE_REASON[reasonCode] ?? "잠시 후 다시 눌러 주세요.";
}

/** 그 곳의 확인 필요 항목이 모두 확인됐는가 — 목록의 [확인했어요]와 같은 상태를 본다 */
function isConfirmed(place: CheckQuestionPlace, items: readonly UnverifiedItem[]): boolean {
  const mine = items.filter((i) => place.findingIds.includes(i.findingId));
  return mine.length > 0 && mine.every((i) => i.confirmedAt !== null);
}

export function CheckQuestionsCard({
  runId,
  itemLabel,
  items = [],
  onChanged,
}: {
  runId: number;
  itemLabel: (itemId: number | null) => string;
  /** 직접 확인할 곳 목록 — 곳마다 [확인했어요] 상태를 여기서 읽는다 */
  items?: readonly UnverifiedItem[];
  /** 확인한 뒤 목록을 다시 읽는다 */
  onChanged?: () => Promise<void>;
}) {
  const [places, setPlaces] = useState<CheckQuestionPlace[] | null>(null);
  const [incomplete, setIncomplete] = useState<CheckQuestions["incomplete"]>(null);
  const [busy, setBusy] = useState(false);
  // 실행 전 거절(예산 · 동시 실행 429)이나 연결 실패 — 서버가 준 까닭을 그대로 붙인다
  const [failure, setFailure] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setFailure(null);
    try {
      const res = await agentApi.checkQuestions(runId);
      setPlaces(res.places);
      setIncomplete(res.incomplete);
    } catch (e) {
      setPlaces(null);
      setIncomplete(null);
      setFailure(isApiError(e) ? e.message : "잠시 후 다시 눌러 주세요.");
    } finally {
      setBusy(false);
    }
  }

  const unfinished = incomplete?.itemIds.length ?? 0;
  return (
    <div className="mt-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
      <div className="flex items-center justify-between gap-3">
        {/* 안내 한 줄 (UI-S3-036) */}
        <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
          전화로 물어볼 내용을 정리해 드려요 · 어디에 무엇을 물어볼지 한 번에 볼 수 있어요
        </p>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="shrink-0 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-60"
        >
          {busy ? "만드는 중…" : "물어볼 내용 만들기"}
        </button>
      </div>
      {failure !== null && <AiUnavailable reason={failure} />}
      {places !== null && (
        <div className="mt-3 space-y-3">
          {places.length > 0 && (
            <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
              전화로 물어볼 내용 · {places.length}곳
              {/* 질문은 AI 가 정리한 것이다 — 판정이 아니다 (FR-CM-010 · FR-AG-022) */}
              <SourceBadge source="AI_NORMALIZED" />
            </p>
          )}
          {places.map((p) => (
            <PlaceQuestions key={p.itemId} place={p} itemLabel={itemLabel} confirmed={isConfirmed(p, items)} onChanged={onChanged} />
          ))}
          {/*
            끝나지 않은 곳은 「확인할 곳이 없어요」로 적지 않는다 — 있는데 없다고 말하게 된다
            (FR-AG-005 · EX-AG-002). 끝난 곳만 보이고 나머지는 사람이 하는 길(아래 목록)을 둔다.
          */}
          {incomplete !== null && (
            <AiUnavailable
              reason={incompleteReasonText(incomplete.reasonCode)}
              scope={places.length > 0 && unfinished > 0 ? `나머지 ${unfinished}곳은 ` : ""}
            />
          )}
          {places.length === 0 && incomplete === null && (
            <p className="text-sm text-slate-500 dark:text-slate-400">전화로 확인할 곳이 없어요.</p>
          )}
          {places.length > 0 && (
            <p className="text-xs text-slate-400">확인한 내용에 맞게 일정을 고치면, 다시 검수할 때 반영돼요.</p>
          )}
        </div>
      )}
    </div>
  );
}

/** AI 로 정리하지 못했다 — 까닭 한 줄과 사람이 하는 길 (FR-AG-005 · EX-AG-001) */
function AiUnavailable({ reason, scope = "" }: { reason: string; scope?: string }) {
  return (
    <div role="status" data-ai-unavailable className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
      <p className="font-medium">{scope}지금은 AI로 정리할 수 없어요.</p>
      <p className="mt-0.5">{reason}</p>
      <p className="mt-0.5">아래 목록의 문의처로 직접 확인할 수 있어요.</p>
    </div>
  );
}

function PlaceQuestions({
  place,
  itemLabel,
  confirmed,
  onChanged,
}: {
  place: CheckQuestionPlace;
  itemLabel: (itemId: number | null) => string;
  confirmed: boolean;
  onChanged?: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(place.questions.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 클립보드가 막혀 있으면 조용히 둔다 — 질문은 화면에 그대로 있다
    }
  }

  // 목록의 [확인했어요]와 같은 일이다 — 그 곳의 확인 필요 항목을 확인으로 적는다. 점수는 그대로다 (FR-AG-022)
  async function confirm() {
    if (confirmed) return;
    setBusy(true);
    setErr(null);
    try {
      await Promise.all(place.findingIds.map((id) => auditApi.confirmFinding(id)));
      await onChanged?.();
    } catch (e) {
      setErr(isApiError(e) ? e.message : "확인 표시를 남기지 못했어요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800" data-place={place.itemId}>
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
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={copy}
          className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          {copied ? "복사했어요" : "질문 복사"}
        </button>
        <button
          type="button"
          onClick={confirm}
          disabled={busy || confirmed}
          className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          {confirmed ? "확인함" : "확인했어요"}
        </button>
        {err !== null && <span className="text-xs text-rose-600 dark:text-rose-400">{err}</span>}
      </div>
    </div>
  );
}
