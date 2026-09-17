"use client";

// 화면 2 · 기획 (UI-S2 · FR-PL-004~006). 상품을 만들면 여기로 온다. 일정의 각 장소를
// 공사 콘텐츠로 고르거나(장소 찾기) 직접 정한 곳으로 둔다. 고른 방식은 서버가 남긴다(D8).
// 일정 구조(추가 · 삭제 · 시각) 편집은 편집 화면에서 한다.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isApiError, planApi, productApi, type PlaceFacts, type ProductDetail, type ProductItem } from "../../../../lib/api";
import { PlaceAutocomplete } from "./place-autocomplete";
import { PlaceFactsLine } from "./place-facts-line";
import { DaySummary } from "./day-summary";
import { PendingBar } from "./pending-bar";
import { StartAuditSheet } from "./start-audit-sheet";

const ITEM_TYPE_LABEL: Record<string, string> = {
  SIGHT: "관광", MEAL: "식사", LODGING: "숙박", REST: "휴식", MOVE: "이동", FREE: "자유",
};

export function PlanEditor({ productId }: { productId: number }) {
  const router = useRouter();
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [facts, setFacts] = useState<Map<number, PlaceFacts>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const d = await productApi.detail(productId);
    setProduct(d);
    // 고른 곳의 장소 정보 한 줄. 고른 항목이 있을 때만 부른다 (없으면 공사 호출 0)
    const hasConfirmed = d.days.some((day) => day.items.some((it) => it.matchStatus === "CONFIRMED"));
    if (hasConfirmed) {
      try {
        const res = await planApi.placeFacts(productId);
        setFacts(new Map(res.items.map((f) => [f.itemId, f])));
      } catch {
        // 장소 정보를 못 읽어도 기획은 계속된다 — 한 줄만 비운다
      }
    }
  }, [productId]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await load();
      } catch (e) {
        if (isApiError(e) && e.status === 401) {
          router.replace("/login");
          return;
        }
        if (alive) setError(isApiError(e) ? e.message : "상품을 불러오지 못했어요.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [load, router]);

  const refetch = useCallback(async () => {
    try {
      await load();
    } catch {
      // 다시 읽기 실패는 조용히 둔다 — 다음 동작에서 갱신된다
    }
  }, [load]);

  if (error !== null && product === null) {
    return <div className="mt-8 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">{error}</div>;
  }
  if (product === null) return <p className="mt-8 text-sm text-slate-400">불러오는 중…</p>;

  const regionLabel = [product.region.regnName, product.region.signguName].filter(Boolean).join(" ") || "이 지역";
  const pending = product.days.flatMap((d) => d.items).filter((it) => it.matchStatus === "PENDING").length;

  return (
    <>
      <nav className="mb-6 text-sm text-slate-500 dark:text-slate-400">
        <Link href="/" className="hover:underline">내 상품</Link>
        <span className="mx-1">/</span>
        <span className="text-slate-700 dark:text-slate-200">{product.name}</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">기획</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {regionLabel} · {product.startDate} · 장소를 고르면 이용시간과 쉬는 날을 볼 수 있어요.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden text-xs text-slate-400 sm:inline">자동 저장됨</span>
          <Link href={`/products/${productId}/edit`} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
            일정 편집
          </Link>
          <StartAuditSheet productId={productId} pendingCount={pending} />
        </div>
      </div>

      {pending > 0 ? (
        <PendingBar productId={productId} pendingCount={pending} onResolved={refetch} />
      ) : (
        <p className="mt-4 rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
          모든 장소를 골랐어요. 검수 시작을 누르면 돼요.
        </p>
      )}

      <div className="mt-6 space-y-6">
        {product.days.map((day) => (
          <section key={day.day}>
            <DaySummary day={day.day} items={day.items} />
            <ul className="mt-2 space-y-2">
              {day.items.map((it) => (
                <ItemRow
                  key={it.itemId}
                  item={it}
                  facts={facts.get(it.itemId) ?? null}
                  regnCd={product.ldongRegnCd}
                  signguCd={product.ldongSignguCd}
                  regionLabel={regionLabel}
                  onResolved={refetch}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}

function ItemRow({
  item,
  facts,
  regnCd,
  signguCd,
  regionLabel,
  onResolved,
}: {
  item: ProductItem;
  facts: PlaceFacts | null;
  regnCd: string;
  signguCd: string | null;
  regionLabel: string;
  onResolved: () => Promise<void>;
}) {
  // 숙박은 끝 시간이 없다. 그 밖에 끝 시간을 비운 항목은 검수가 보통 머무는 시간으로 채운다.
  const endHint = item.matchStatus !== "EXCLUDED" && item.end === null && item.itemType !== "LODGING";
  return (
    <li className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{item.place}</span>
          <span className="ml-2 text-xs text-slate-400">
            {item.start}
            {item.end !== null ? `~${item.end}` : ""} · {ITEM_TYPE_LABEL[item.itemType] ?? item.itemType}
          </span>
        </div>
        <StatusTag status={item.matchStatus} />
      </div>
      {item.matchStatus === "CONFIRMED" && facts !== null && <PlaceFactsLine facts={facts} />}
      {item.matchStatus === "EXCLUDED" && (
        <p className="mt-1 text-xs text-slate-400">이용시간 정보는 표시되지 않아요.</p>
      )}
      {endHint && <p className="mt-1 text-xs text-slate-400">끝 시간을 비우면 보통 머무는 시간으로 채워요.</p>}
      {item.matchStatus === "PENDING" && (
        <PlaceAutocomplete item={item} regnCd={regnCd} signguCd={signguCd} regionLabel={regionLabel} onResolved={onResolved} />
      )}
    </li>
  );
}

function StatusTag({ status }: { status: string }) {
  if (status === "CONFIRMED") {
    return <span className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">고른 곳</span>;
  }
  if (status === "EXCLUDED") {
    return <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">직접 정한 곳</span>;
  }
  return <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">고르는 중</span>;
}
