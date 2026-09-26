"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { isApiError, planApi, type PlanPlace, type PlanPlaces } from "../../lib/api";

type Query = Parameters<typeof planApi.places>[0];
const PAGE_SIZE = 20;

/**
 * 조회 조건이 달라지면 페이지와 진행 중 요청을 함께 초기화한다.
 *
 * `onClearFilters` 를 주면 0곳일 때 빈 상태에 「필터 모두 끄기」 를 둔다 — 필터가 켜져 있을 때만
 * 준다 (UI-S2-038 · EX-PL-001). `onLoaded` 는 받은 쪽 수를 알려 준다 — 누른 근처 칩에 개수를 적는다
 * (UI-S2-037).
 */
export function PlaceResults({ query, children, onClearFilters, onLoaded }: {
  query: Query | null;
  children: (place: PlanPlace) => ReactNode;
  onClearFilters?: () => void;
  onLoaded?: (data: PlanPlaces) => void;
}) {
  return query === null ? null : (
    <PagedPlaces key={JSON.stringify(query)} query={query} onClearFilters={onClearFilters} onLoaded={onLoaded}>{children}</PagedPlaces>
  );
}

function PagedPlaces({ query, children, onClearFilters, onLoaded }: {
  query: Query;
  children: (place: PlanPlace) => ReactNode;
  onClearFilters?: () => void;
  onLoaded?: (data: PlanPlaces) => void;
}) {
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ request: string; data: PlanPlaces | null; error: string | null } | null>(null);
  const top = useRef<HTMLDivElement>(null);
  // 부모가 그릴 때마다 새 함수를 줘도 다시 부르지 않게 조회 효과 밖에서 든다
  const loaded = useRef(onLoaded);
  useEffect(() => { loaded.current = onLoaded; }, [onLoaded]);
  const requestKey = `${page}:${attempt}`;
  const queryKey = JSON.stringify(query);
  const current = result?.request === requestKey ? result : null;
  const loading = current === null;
  const data = current?.data;
  const total = result?.data?.totalCount ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    let alive = true;
    void planApi.places({ ...JSON.parse(queryKey) as Query, page }).then(
      (data) => {
        if (!alive) return;
        setResult({ request: requestKey, data, error: null });
        loaded.current?.(data);
      },
      (error: unknown) => { if (alive) setResult({ request: requestKey, data: null, error: isApiError(error) ? error.message : "장소를 불러오지 못했어요. 다시 시도해 주세요." }); },
    );
    return () => { alive = false; };
  }, [queryKey, page, requestKey]);

  function move(next: number) {
    setPage(next);
    top.current?.focus({ preventScroll: true });
    top.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  const range = data && data.items.length
    ? `전체 ${data.totalCount}곳 중 ${(page - 1) * PAGE_SIZE + 1}–${(page - 1) * PAGE_SIZE + data.items.length}곳`
    : null;

  const navigation = (position: string) => (
    <nav aria-label={`장소 목록 페이지 ${position}`} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 p-2 text-xs dark:bg-slate-900">
      <button type="button" disabled={loading || page <= 1} onClick={() => move(page - 1)} className="rounded-md border border-slate-200 bg-white px-3 py-2 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-950">← 이전</button>
      <span className="tabular-nums">{page} / {pages} 페이지</span>
      <button type="button" disabled={loading || page >= pages} onClick={() => move(page + 1)} className="rounded-md border border-slate-200 bg-white px-3 py-2 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-950">다음 →</button>
    </nav>
  );

  return (
    <div ref={top} tabIndex={-1} className="mt-3 scroll-mt-24 outline-none" aria-busy={loading}>
      <p role="status" className="mb-2 text-xs text-slate-500">
        {loading ? "장소를 불러오는 중…" : data ? `${data.scope.label} · ${range ?? `전체 ${data.totalCount}곳`}` : "장소 조회 실패"}
      </p>
      {total > PAGE_SIZE && navigation("위")}
      {current?.error ? <div role="alert" className="mt-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">
        <p>{current.error}</p>
        <button type="button" onClick={() => setAttempt((n) => n + 1)} className="mt-2 rounded-md border px-3 py-1.5">다시 시도</button>
      </div> : null}
      {data?.notice && <p className="mt-2 text-xs text-slate-500">{data.notice}</p>}
      {data && (data.items.length ? <ul className="my-3 space-y-2">{data.items.map(children)}</ul> : (
        <div className="my-3 flex flex-wrap items-center gap-2 text-sm text-slate-500">
          <p>이 조건에 맞는 장소가 없어요.</p>
          {/* 필터를 저절로 풀지 않는다 — 끄는 것은 사람이 누른다 (EX-PL-001) */}
          {onClearFilters && page === 1 && (
            <button type="button" onClick={onClearFilters} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
              필터 모두 끄기
            </button>
          )}
        </div>
      ))}
      {data && data.items.length === 0 && page > 1 && <button type="button" onClick={() => move(1)} className="my-2 text-sm underline">첫 페이지로 돌아가기</button>}
      {/* 목록 아래에도 전체 수 · 지금 범위 (UI-S2-036) */}
      {range !== null && <p className="mb-2 text-xs text-slate-500">{range}</p>}
      {total > PAGE_SIZE && navigation("아래")}
    </div>
  );
}
