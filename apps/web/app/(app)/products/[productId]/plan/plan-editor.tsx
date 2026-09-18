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
import { PlacePicker } from "./place-picker";
import { hhmm, savedLabel } from "../../../../lib/save-status";

const ITEM_TYPE_LABEL: Record<string, string> = {
  SIGHT: "관광", MEAL: "식사", LODGING: "숙박", REST: "휴식", MOVE: "이동", FREE: "자유",
};

export function PlanEditor({ productId, openType = null }: { productId: number; openType?: string | null }) {
  const router = useRouter();
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [facts, setFacts] = useState<Map<number, PlaceFacts>>(new Map());
  const [error, setError] = useState<string | null>(null);
  // 이번 세션에서 마지막으로 저장된 시각 (hh:mm). null = 아직 이 화면에서 저장 안 함
  const [savedAt, setSavedAt] = useState<string | null>(null);

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

  // 편집(장소 고르기·담기·항목 변경)이 저장되면 그 시각을 남긴다 (개편안 변경 지점 8).
  // 저장 자체는 항목 API 가 이미 했고, 여기서는 표시와 다시 읽기만 한다.
  const handleSaved = useCallback(async () => {
    setSavedAt(hhmm(new Date()));
    await refetch();
  }, [refetch]);

  if (error !== null && product === null) {
    return <div className="mt-8 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">{error}</div>;
  }
  if (product === null) return <p className="mt-8 text-sm text-slate-400">불러오는 중…</p>;

  const regionLabel = [product.region.regnName, product.region.signguName].filter(Boolean).join(" ") || "이 지역";
  const allItems = product.days.flatMap((d) => d.items);
  const pending = allItems.filter((it) => it.matchStatus === "PENDING").length;
  const empty = allItems.length === 0;

  return (
    <>
      <nav className="mb-6 text-sm text-slate-500 dark:text-slate-400">
        <Link href="/planning" className="hover:underline">기획</Link>
        <span className="mx-1">/</span>
        <span className="text-slate-700 dark:text-slate-200">{product.name}</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">{product.name}</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {regionLabel} · {product.startDate} · 장소를 고르면 이용시간과 쉬는 날을 볼 수 있어요.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden text-xs text-slate-400 sm:inline" aria-live="polite">{savedLabel(savedAt)}</span>
          <Link href={`/products/${productId}/edit`} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
            일정 편집
          </Link>
          {product.plannedAt === null ? (
            <StartAuditSheet productId={productId} pendingCount={pending} />
          ) : (
            <Link href={`/products/${productId}`} className="button-primary">
              검수 결과로 돌아가기
            </Link>
          )}
        </div>
      </div>

      {/* 편집기(왼쪽) · 장소 담기(오른쪽) 2단 (UI-S2-036). 좁은 화면에선 세로로 쌓인다 */}
      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="min-w-0">
          {pending > 0 ? (
            <PendingBar
              productId={productId}
              pendingCount={pending}
              items={product.days.flatMap((d) => d.items)}
              regnCd={product.ldongRegnCd}
              signguCd={product.ldongSignguCd}
              regionLabel={regionLabel}
              onResolved={handleSaved}
            />
          ) : empty ? (
            <p className="rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              아직 일정이 없어요. 오른쪽 장소 담기로 장소를 넣어 보세요.
            </p>
          ) : (
            <p className="rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
              {product.plannedAt === null
                ? "모든 장소를 골랐어요. 검수 시작을 누르면 돼요."
                : "장소를 보완했다면 검수 결과로 돌아가 ‘지금 재검수’를 눌러 주세요."}
            </p>
          )}

          <div className="mt-6 space-y-6">
            {product.days.map((day) => (
              <section key={day.day} className="plan-day">
                <DaySummary day={day.day} items={day.items} />
                <ul className="plan-timeline">
                  {day.items.map((it, index) => (
                    <ItemRow
                      key={it.itemId}
                      item={it}
                      position={index + 1}
                      facts={facts.get(it.itemId) ?? null}
                      regnCd={product.ldongRegnCd}
                      signguCd={product.ldongSignguCd}
                      regionLabel={regionLabel}
                      onResolved={handleSaved}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>

        {/* 오른쪽 장소 담기 도우미 — 넓은 화면에선 스크롤해도 붙어 있게 (UI-S2-036) */}
        <aside className="lg:sticky lg:top-4">
          <PlacePicker product={product} onInserted={handleSaved} openType={openType} />
        </aside>
      </div>
    </>
  );
}

function ItemRow({
  item,
  position,
  facts,
  regnCd,
  signguCd,
  regionLabel,
  onResolved,
}: {
  item: ProductItem;
  position: number;
  facts: PlaceFacts | null;
  regnCd: string;
  signguCd: string | null;
  regionLabel: string;
  onResolved: () => Promise<void>;
}) {
  // 숙박은 끝 시간이 없다. 그 밖에 끝 시간을 비운 항목은 검수가 보통 머무는 시간으로 채운다.
  const endHint = item.matchStatus !== "EXCLUDED" && item.end === null && item.itemType !== "LODGING";
  return (
    <li className="plan-timeline-item">
      {position > 1 && (
        <div className="plan-transfer">
          <span aria-hidden="true">↓</span>
          {facts?.travelFromPrevMinutes != null
            ? `앞 장소에서 차로 ${facts.travelFromPrevMinutes === 0 ? "1분 미만" : `약 ${facts.travelFromPrevMinutes}분`}`
            : "이 구간의 이동시간은 직접 확인해 주세요"}
          <span className="plan-transfer-note">예상 소요시간</span>
        </div>
      )}
      <article className="plan-stop">
      <header className="plan-stop-header">
        <span className="plan-stop-number" aria-label={`${position}번째 장소`}>{String(position).padStart(2, "0")}</span>
        <div className="plan-stop-heading">
          <p className="plan-stop-time">{item.start}{item.end !== null ? ` – ${item.end}` : ""}<span>{ITEM_TYPE_LABEL[item.itemType] ?? item.itemType}</span></p>
          <h3>{item.place || "장소를 골라 주세요"}</h3>
        </div>
        <StatusTag status={item.matchStatus} />
      </header>
      {item.matchStatus === "CONFIRMED" && facts !== null && <PlaceFactsLine facts={facts} />}
      {item.matchStatus === "EXCLUDED" && (
        <p className="mt-1 text-xs text-slate-400">이용시간 정보는 표시되지 않아요.</p>
      )}
      {endHint && <p className="mt-1 text-xs text-slate-400">끝 시간을 비우면 보통 머무는 시간으로 채워요.</p>}
      {item.matchStatus === "PENDING" && (
        <PlaceAutocomplete item={item} regnCd={regnCd} signguCd={signguCd} regionLabel={regionLabel} onResolved={onResolved} />
      )}
      </article>
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
