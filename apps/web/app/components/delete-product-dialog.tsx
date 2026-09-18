"use client";

import { useEffect, useRef, useState } from "react";
import { isApiError, productApi } from "../lib/api";

export function DeleteProductDialog({ product, onClose, onDeleted }: {
  product: { productId: number; name: string };
  onClose: () => void;
  onDeleted: (id: number) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  async function remove() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await productApi.remove(product.productId);
      onDeleted(product.productId);
    } catch (err) {
      setError(isApiError(err) ? err.message : "삭제하지 못했어요. 다시 시도해 주세요.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} className="product-delete-dialog" aria-labelledby="delete-product-title"
      aria-describedby="delete-product-description" onCancel={(event) => {
        event.preventDefault();
        if (!inFlight.current) onClose();
      }}>
      <span className="delete-dialog-label">상품 삭제</span>
      <h2 id="delete-product-title">이 상품을 삭제할까요?</h2>
      <p className="delete-product-name">{product.name}</p>
      <p id="delete-product-description">상품의 일정과 검수 기록이 함께 삭제됩니다. 삭제한 상품은 복구할 수 없습니다.</p>
      {error && <p role="alert" className="delete-error">{error}</p>}
      <div className="delete-dialog-actions">
        <button type="button" className="button-secondary" autoFocus disabled={busy} onClick={onClose}>취소</button>
        <button type="button" className="button-danger" disabled={busy} onClick={remove}>
          {busy ? "삭제 중…" : "상품 삭제"}
        </button>
      </div>
    </dialog>
  );
}
