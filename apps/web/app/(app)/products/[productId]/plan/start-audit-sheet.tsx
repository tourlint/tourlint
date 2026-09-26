"use client";

// 검수 시작 창 (D7 · FR-PL-020 · UI-S2-042). 누르면 무엇을 확인하는지 알려 주고, 고르지 않은
// 곳이 남았으면 그 목록과 [AI로 한 번에 찾기] · [이대로 검수 시작] · [돌아가기]를 준다
// (UI-S2-023 · EX-PL-005). 예산이 다 차면 429 로 막히고 상품은 기획 중에 남는다 — 무엇이 · 왜 ·
// 다음에 무엇을 할지 안내한다.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { isApiError, productApi } from "../../../../lib/api";
import { AuditBudgetNotice, budgetBlockedText, useAuditAvailability } from "../../../../lib/audit-availability";
import { lineLabel } from "./line-label";

/** 창에 적는 고르지 않은 줄 — 일차 · 시각 · 이름 */
export interface PendingLine {
  readonly itemId: number;
  readonly day: number;
  readonly start: string;
  readonly place: string;
}

export function StartAuditSheet({
  productId,
  pendingCount,
  pendingItems = [],
  onFindAll,
}: {
  productId: number;
  pendingCount: number;
  pendingItems?: readonly PendingLine[];
  /** 창을 닫고 기획 화면의 [AI로 한 번에 찾기]를 돌린다 */
  onFindAll?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 예산이 다 되면 누르기 전에 막고 다시 열리는 때를 적는다 (UI-ST-007 · #838)
  const budget = useAuditAvailability();

  async function start(excludePending: boolean) {
    setBusy(true);
    setErr(null);
    setBlocked(null);
    try {
      await productApi.handoff(productId, excludePending);
      // 검수가 걸렸다 — 결과 화면에서 진행을 본다
      router.push(`/products/${productId}`);
    } catch (e) {
      // 분당 상한(RATE_LIMIT_EXCEEDED)은 잠시 뒤 다시 되는 것이라 예산 소진과 가른다 — 서버 문구를 그대로 보인다
      if (isApiError(e) && e.status === 429 && e.reasonCode !== "RATE_LIMIT_EXCEEDED") {
        // 예산 100% — 상품은 기획 중에 남는다. 버튼도 막는다
        setBlocked(`${budgetBlockedText(budget.resumesAt)} 상품은 기획 중에 그대로 있어요.`);
        budget.refresh();
        setBusy(false);
        return;
      }
      setErr(isApiError(e) ? e.message : "검수를 시작하지 못했어요.");
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={budget.blocked}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          검수 시작 →
        </button>
        {budget.blocked && <AuditBudgetNotice resumesAt={budget.resumesAt} className="max-w-xs text-xs" />}
      </div>

      {open && (
        <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/30 p-4 sm:items-center" onClick={() => !busy && setOpen(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">검수를 시작할까요?</h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              문 여는 날인지, 행사 기간인지, 이동 시간이 충분한지 확인해서 결과를 보여 드려요.
            </p>

            {blocked !== null ? (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">{blocked}</p>
            ) : pendingCount > 0 ? (
              <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                <p>아직 고르지 않은 곳이 {pendingCount}곳 있어요. 이대로 시작하면 그곳은 검수에서 빠져요.</p>
                {pendingItems.length > 0 && (
                  <ul aria-label="아직 고르지 않은 곳" className="mt-2 max-h-40 space-y-0.5 overflow-y-auto text-xs">
                    {pendingItems.map((p) => (
                      // AI 카드 줄과 같은 말로 가리킨다 — 「1일차 09:00 · 강릉역」
                      <li key={p.itemId}>{lineLabel(p)}</li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
            {err && <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{err}</p>}

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                돌아가기
              </button>
              {blocked === null && pendingCount > 0 && onFindAll !== undefined && (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onFindAll();
                  }}
                  disabled={busy}
                  className="rounded-lg border border-indigo-300 px-4 py-2 text-sm font-medium text-indigo-600 transition hover:bg-indigo-50 disabled:opacity-60 dark:border-indigo-800 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
                >
                  AI로 한 번에 찾기
                </button>
              )}
              {blocked === null && (
                <button
                  type="button"
                  onClick={() => void start(pendingCount > 0)}
                  disabled={busy}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-60"
                >
                  {busy ? "시작하는 중…" : pendingCount > 0 ? "이대로 검수 시작" : "검수 시작"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
