"use client";

// 검수 시작 창 (D7 · FR-PL-020 · UI-S2-045). 누르면 무엇을 확인하는지 알려 주고, 고르지 않은
// 곳이 남았으면 이대로 검수를 시작할지 묻는다. 예산이 다 차면 429 로 막히고 상품은 기획 중에
// 남는다 — 무엇이 · 왜 · 다음에 무엇을 할지 안내한다.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { isApiError, productApi } from "../../../../lib/api";

export function StartAuditSheet({ productId, pendingCount }: { productId: number; pendingCount: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function start(excludePending: boolean) {
    setBusy(true);
    setErr(null);
    setBlocked(null);
    try {
      await productApi.handoff(productId, excludePending);
      // 검수가 걸렸다 — 결과 화면에서 진행을 본다
      router.push(`/products/${productId}`);
    } catch (e) {
      if (isApiError(e) && e.status === 429) {
        // 예산 100% — 상품은 기획 중에 남는다
        setBlocked("오늘 공사 데이터 조회량을 다 써서 지금은 검수를 시작할 수 없어요. 내일 다시 시도하거나 관리자에게 예산 상향을 요청해 주세요. 상품은 기획 중에 그대로 있어요.");
        setBusy(false);
        return;
      }
      setErr(isApiError(e) ? e.message : "검수를 시작하지 못했어요.");
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
      >
        검수 시작 →
      </button>

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
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                아직 고르지 않은 곳이 {pendingCount}곳 있어요. 이대로 시작하면 그곳은 검수에서 빠져요.
              </p>
            ) : null}
            {err && <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{err}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                돌아가기
              </button>
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
