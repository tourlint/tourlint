"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { isApiError, planApi, type PlanPlace, type PlanPlaces } from "../../lib/api";

type Query = Parameters<typeof planApi.places>[0];
const PAGE_SIZE = 20;

/** 조회 조건이 달라지면 페이지와 진행 중 요청을 함께 초기화한다. */
export function PlaceResults({ query, children }: { query: Query | null; children: (place: PlanPlace) => ReactNode }) {
  return query === null ? null : <PagedPlaces key={JSON.stringify(query)} query={query}>{children}</PagedPlaces>;
}

function PagedPlaces({ query, children }: { query: Query; children: (place: PlanPlace) => ReactNode }) {
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ request: string; data: PlanPlaces | null; error: string | null } | null>(null);
  const top = useRef<HTMLDivElement>(null);
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
      (data) => { if (alive) setResult({ request: requestKey, data, error: null }); },
      (error: unknown) => { if (alive) setResult({ request: requestKey, data: null, error: isApiError(error) ? error.message : "장소를 불러오지 못했어요. 다시 시도해 주세요." }); },
    );
    return () => { alive = false; };
  }, [queryKey, page, requestKey]);

  function move(next: number) {
    setPage(next);
    top.current?.focus({ preventScroll: true });
    top.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

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
        {loading ? "장소를 불러오는 중…" : data ? `${data.scope.label} · 전체 ${data.totalCount}곳${data.items.length ? ` 중 ${(page - 1) * PAGE_SIZE + 1}–${(page - 1) * PAGE_SIZE + data.items.length}곳` : ""}` : "장소 조회 실패"}
      </p>
      {total > PAGE_SIZE && navigation("위")}
      {current?.error ? <div role="alert" className="mt-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">
        <p>{current.error}</p>
        <button type="button" onClick={() => setAttempt((n) => n + 1)} className="mt-2 rounded-md border px-3 py-1.5">다시 시도</button>
      </div> : null}
      {data?.notice && <p className="mt-2 text-xs text-slate-500">{data.notice}</p>}
      {data && (data.items.length ? <ul className="my-3 space-y-2">{data.items.map(children)}</ul> : <p className="my-3 text-sm text-slate-500">이 조건에 맞는 장소가 없어요.</p>)}
      {data && data.items.length === 0 && page > 1 && <button type="button" onClick={() => move(1)} className="my-2 text-sm underline">첫 페이지로 돌아가기</button>}
      {total > PAGE_SIZE && navigation("아래")}
    </div>
  );
}
