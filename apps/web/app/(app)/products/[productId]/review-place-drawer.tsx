"use client";

import { useEffect, useRef, useState } from 'react';
import type { ProductDetail } from '../../../lib/api';
import { PlacePicker, type PickerContext } from './plan/place-picker';

export function ReviewPlaceDrawer({ product, context, changed, onInserted, onClose, onReaudit }: {
  product: ProductDetail; context: PickerContext; changed: boolean;
  onInserted: () => Promise<void>; onClose: () => void; onReaudit: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return <dialog ref={dialog} onCancel={e => { if (saving) e.preventDefault(); else onClose(); }} aria-labelledby="review-place-title"
    className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-full max-w-xl border-0 bg-white p-0 text-slate-800 shadow-2xl backdrop:bg-slate-900/30 dark:bg-slate-950 dark:text-slate-100">
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-4 border-b border-slate-200 p-5">
        <div><h2 id="review-place-title" className="text-lg font-semibold">일정에 장소 더하기</h2>
          <p className="mt-2 text-sm text-slate-500">넣을 일차와 위치를 확인한 뒤 장소를 담으세요. 앞 장소의 종료시간과 예상 이동시간을 반영해 추가합니다.</p>
          <p className="mt-1 text-xs text-slate-500">기존 장소를 바꾸거나 시간을 직접 조정하려면 ‘일정 편집’을 이용하세요.</p></div>
        <button type="button" className="button-secondary shrink-0" disabled={saving} onClick={onClose}>닫기</button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <PlacePicker product={product} onInserted={onInserted} onBusyChange={setSaving} showExtras={false} {...context} />
      </div>
      <footer className="border-t border-slate-200 p-4">
        <p role="status" className="mb-3 text-sm text-slate-600">{changed ? '일정에 반영했어요. 재검수하면 추가한 장소까지 확인합니다.' : '‘일정에 넣기’를 누르면 바로 저장됩니다. 추가 후 재검수해 주세요.'}</p>
        <button type="button" className="button-primary w-full disabled:opacity-50" disabled={!changed || saving} onClick={onReaudit}>담은 일정 재검수</button>
      </footer>
    </div>
  </dialog>;
}
