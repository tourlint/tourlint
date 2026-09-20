"use client";

import { useEffect, useRef } from "react";

/**
 * 작성 중에 취소를 누르면 한 번 묻는다 (#657). 되돌릴 자리를 주고, 남겨 두는 방법도 알려
 * 준다 — 「저장」 을 누르면 기획중으로 남는다.
 */
export function LeaveConfirm({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="leave-title"
      aria-describedby="leave-description"
      onCancel={(event) => {
        event.preventDefault();
        onStay();
      }}
      className="w-[23rem] max-w-[90vw] rounded-xl border border-slate-200 bg-white p-5 text-slate-900 shadow-xl backdrop:bg-slate-900/40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    >
      <h2 id="leave-title" className="text-base font-semibold">
        저장하지 않고 나갈까요?
      </h2>
      <p id="leave-description" className="mt-2 text-sm text-slate-600 dark:text-slate-300">
        지금 작성한 내용은 사라집니다. 「저장」 을 누르면 기획중으로 남겨 두고 나중에 이어서
        할 수 있어요.
      </p>
      <div className="mt-5 flex justify-end gap-3">
        <button
          type="button"
          autoFocus
          onClick={onStay}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          계속 작성
        </button>
        <button
          type="button"
          onClick={onLeave}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
        >
          나가기
        </button>
      </div>
    </dialog>
  );
}
