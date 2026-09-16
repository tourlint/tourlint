"use client";

// 화면 1 · 상품 대시보드 (UI-S1). 허브 화면 — 여기서 신규 등록(/products/new)과
// 상품 선택(→ 검수 결과 /products/:id)으로 분기한다. 헤더·푸터는 (app)/layout 이 준다.
// 예산 위젯(UI-S1-004/005)은 별도 이슈다.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isApiError } from "../lib/api";
import { GradeCounts, StatusBadge } from "../components/badges";
import { STAGE_LABEL, STAGE_ORDER, stageOf, type Stage } from "../lib/stage-of";

interface LatestAudit {
  executedAt: string;
  readinessScore: number | null;
  isPartial: boolean;
  releasable: boolean;
  counts: { blocker: number; error: number; warning: number; unverified: number };
}

interface Product {
  productId: number;
  name: string;
  startDate: string;
  nights: number;
  region?: { regnName?: string; signguName?: string };
  latestAudit?: LatestAudit | null;
  plannedAt?: string | null;
  releasedAt?: string | null;
  pendingMatches?: number;
}

type View = "board" | "list";

const NIGHTS_LABEL = ["당일", "1박 2일", "2박 3일"];

type SortKey = "startDate" | "readiness" | "audited";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "startDate", label: "출발일" },
  { key: "readiness", label: "준비도" },
  { key: "audited", label: "검수 시각" },
];

/** 오늘(로컬) 날짜를 YYYY-MM-DD 로. startDate 와 사전식 비교하면 날짜순 비교가 된다. */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function sortProducts(list: Product[], key: SortKey): Product[] {
  const arr = [...list];
  switch (key) {
    case "readiness":
      // 준비도 높은 순. 미검수·부분검수(점수 null)는 뒤로.
      return arr.sort(
        (a, b) =>
          (b.latestAudit?.readinessScore ?? -1) - (a.latestAudit?.readinessScore ?? -1) ||
          a.startDate.localeCompare(b.startDate),
      );
    case "audited":
      // 최근 검수 순. 미검수는 뒤로.
      return arr.sort(
        (a, b) =>
          (b.latestAudit?.executedAt ?? "").localeCompare(a.latestAudit?.executedAt ?? "") ||
          a.startDate.localeCompare(b.startDate),
      );
    default:
      // 출발일 오름차순 (기본, UI-S1-007)
      return arr.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.productId - b.productId);
  }
}

export default function DashboardPage() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("startDate");
  const [showPast, setShowPast] = useState(false);
  const [view, setView] = useState<View>("board");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/v1/products", { credentials: "include" });
        if (alive && res.ok) {
          const json = (await res.json()) as { content?: Product[] };
          setProducts(json.content ?? []);
        }
      } catch (err) {
        if (isApiError(err) && err.status === 401) router.replace("/login");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [router]);

  // 출발일이 지난 상품은 기본 목록에서 접는다 (UI-S1-008).
  const { upcoming, past } = useMemo(() => {
    const today = todayIso();
    const up: Product[] = [];
    const old: Product[] = [];
    for (const p of products) (p.startDate >= today ? up : old).push(p);
    return { upcoming: sortProducts(up, sortKey), past: sortProducts(old, sortKey) };
  }, [products, sortKey]);

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">내 상품</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            기획 · 검수 · 출시 단계로 봅니다. 검수 대상은 당일 ~ 2박 3일입니다.
          </p>
        </div>
        {/* 새 상품 기획 진입점 (UI-S1-006) */}
        <Link
          href="/products/new"
          className="shrink-0 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
        >
          새 상품 기획
        </Link>
      </div>

      {loading ? (
        <p className="mt-8 text-sm text-slate-400">불러오는 중…</p>
      ) : products.length === 0 ? (
        // 빈 상태 (UI-S1-009)
        <div className="mt-10 rounded-2xl border border-dashed border-slate-300 py-16 text-center dark:border-slate-700">
          <p className="text-sm text-slate-500 dark:text-slate-400">등록된 상품이 없습니다.</p>
          <Link
            href="/products/new"
            className="mt-4 inline-block rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
          >
            첫 상품 등록하기
          </Link>
        </div>
      ) : (
        <>
          {/* 보드 · 목록 전환 (UI-S1-001) */}
          <div className="mt-6 flex items-center gap-1 text-sm">
            {(["board", "list"] as View[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={view === v}
                className={`rounded-md px-2.5 py-1 font-medium transition ${
                  view === v
                    ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                    : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                }`}
              >
                {v === "board" ? "보드" : "목록"}
              </button>
            ))}
          </div>

          {view === "board" ? (
            <StageBoard products={upcoming} />
          ) : (
            <ListView
              upcoming={upcoming}
              past={past}
              sortKey={sortKey}
              setSortKey={setSortKey}
              showPast={showPast}
              setShowPast={setShowPast}
            />
          )}

          {/* 보드 아래 바로 가기 (UI-S1-006) */}
          <div className="mt-6 flex flex-wrap gap-2 text-sm">
            <Link href="/radar" className="rounded-md border border-slate-300 px-3 py-1.5 font-medium text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
              레이더 보기
            </Link>
            <Link href="/standard" className="rounded-md border border-slate-300 px-3 py-1.5 font-medium text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
              검수 기준 보기
            </Link>
          </div>
        </>
      )}
    </>
  );
}

// 단계별 4칸 보드 (UI-S1-001 · 010 · 011). 출발일이 지난 상품은 목록 뷰에서 접어 본다.
function StageBoard({ products }: { products: Product[] }) {
  const byStage: Record<Stage, Product[]> = { PLANNING: [], REVIEW: [], RELEASABLE: [], RELEASED: [] };
  for (const p of products) {
    byStage[stageOf({ plannedAt: p.plannedAt ?? null, releasedAt: p.releasedAt ?? null, latestAudit: p.latestAudit ?? null })].push(p);
  }
  return (
    <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {STAGE_ORDER.map((stage) => (
        <div key={stage} className="rounded-xl border border-slate-200 bg-slate-50/50 p-3 dark:border-slate-800 dark:bg-slate-900/30">
          <h2 className="flex items-center justify-between text-sm font-semibold text-slate-700 dark:text-slate-200">
            {STAGE_LABEL[stage]}
            <span className="tabular-nums text-slate-400">{byStage[stage].length}</span>
          </h2>
          <div className="mt-2 space-y-2">
            {byStage[stage].length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-400">없음</p>
            ) : (
              byStage[stage].map((p) => <BoardCard key={p.productId} product={p} stage={stage} />)
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function BoardCard({ product: p, stage }: { product: Product; stage: Stage }) {
  const a = p.latestAudit ?? null;
  return (
    <Link
      href={`/products/${p.productId}`}
      className="block rounded-lg border border-slate-200 bg-white p-3 transition hover:border-indigo-300 hover:shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:hover:border-indigo-700"
    >
      <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">{p.name}</p>
      <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
        {[p.region?.regnName, p.region?.signguName].filter(Boolean).join(" ") || "지역 미지정"} · {p.startDate}
      </p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{boardHint(p, stage, a)}</p>
    </Link>
  );
}

function boardHint(p: Product, stage: Stage, a: LatestAudit | null): string {
  switch (stage) {
    case "PLANNING":
      return (p.pendingMatches ?? 0) > 0 ? `아직 고르지 않은 장소 ${p.pendingMatches}곳` : "검수 시작 전";
    case "REVIEW":
      if (a === null) return "검수를 시작해요";
      if (a.isPartial) return "부분 검수";
      return a.counts.blocker > 0 ? `차단 ${a.counts.blocker}건` : "검수 중";
    case "RELEASABLE":
      return a?.readinessScore != null ? `${a.readinessScore}점 · 출시할 수 있어요` : "출시할 수 있어요";
    case "RELEASED":
      return p.releasedAt ? `출시함 · ${p.releasedAt.slice(0, 10)}` : "출시함";
  }
}

// 목록 뷰 — 정렬 · 지난 상품 접기 (UI-S1-002 · 007 · 008)
function ListView({
  upcoming,
  past,
  sortKey,
  setSortKey,
  showPast,
  setShowPast,
}: {
  upcoming: Product[];
  past: Product[];
  sortKey: SortKey;
  setSortKey: (k: SortKey) => void;
  showPast: boolean;
  setShowPast: (fn: (v: boolean) => boolean) => void;
}) {
  return (
    <>
          {/* 정렬 전환 (UI-S1-007) */}
          <div className="mt-4 flex items-center justify-end gap-1 text-sm">
            <span className="mr-1 text-slate-400">정렬</span>
            {SORTS.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setSortKey(s.key)}
                aria-pressed={sortKey === s.key}
                className={`rounded-md px-2.5 py-1 font-medium transition ${
                  sortKey === s.key
                    ? "bg-indigo-600 text-white"
                    : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          <table className="mt-3 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500 dark:border-slate-800 dark:text-slate-400">
                <th className="p-3 font-medium">상품명</th>
                <th className="p-3 font-medium">지역</th>
                <th className="p-3 font-medium">출발일</th>
                <th className="p-3 font-medium">일정</th>
                <th className="p-3 font-medium">출시 준비도</th>
                <th className="p-3 font-medium">차단/오류/주의/확인불가</th>
                <th className="p-3 font-medium">최근 검수</th>
              </tr>
            </thead>
            <tbody>
              {upcoming.map((p) => (
                <ProductRow key={p.productId} product={p} />
              ))}

              {past.length > 0 && (
                <tr>
                  <td colSpan={7} className="p-0">
                    <button
                      type="button"
                      onClick={() => setShowPast((v) => !v)}
                      className="w-full border-y border-slate-100 bg-slate-50/60 px-3 py-2 text-left text-xs font-medium text-slate-500 transition hover:bg-slate-100 dark:border-slate-800/60 dark:bg-slate-800/30 dark:text-slate-400 dark:hover:bg-slate-800/60"
                    >
                      {showPast ? "▾" : "▸"} 지난 상품 {past.length}개 {showPast ? "접기" : "펼치기"}
                    </button>
                  </td>
                </tr>
              )}
              {showPast && past.map((p) => <ProductRow key={p.productId} product={p} past />)}
            </tbody>
          </table>
    </>
  );
}

function ProductRow({ product: p, past = false }: { product: Product; past?: boolean }) {
  const a = p.latestAudit ?? null;
  return (
    <tr className={`border-b border-slate-100 dark:border-slate-800/60 ${past ? "opacity-60" : ""}`}>
      <td className="p-3 font-medium">
        {/* 상품 선택 → 검수 결과 (UI-S1-001 · 화면 전이 1→3) */}
        <Link href={`/products/${p.productId}`} className="text-indigo-600 hover:underline dark:text-indigo-400">
          {p.name}
        </Link>
      </td>
      <td className="p-3 text-slate-600 dark:text-slate-300">
        {[p.region?.regnName, p.region?.signguName].filter(Boolean).join(" ") || "-"}
      </td>
      <td className="p-3 text-slate-600 dark:text-slate-300 tabular-nums">{p.startDate}</td>
      <td className="p-3 text-slate-600 dark:text-slate-300">{NIGHTS_LABEL[p.nights] ?? `${p.nights}박`}</td>
      <td className="p-3">
        {a?.isPartial ? (
          <StatusBadge status="PARTIAL" />
        ) : a?.readinessScore != null ? (
          <div className="flex items-center gap-2">
            <strong className="text-slate-900 dark:text-slate-100">{a.readinessScore}점</strong>
            {/* 차단이 있으면 출시 불가 (UI-S1-002) */}
            {!a.releasable && <StatusBadge status="NOT_RELEASABLE" />}
          </div>
        ) : (
          "-"
        )}
      </td>
      <td className="p-3">
        {a ? <GradeCounts counts={a.counts} variant="chip" /> : <span className="text-slate-400">-</span>}
      </td>
      <td className="p-3 text-slate-500 dark:text-slate-400 tabular-nums">
        {a?.executedAt ? formatStamp(a.executedAt) : <span className="text-slate-400">-</span>}
      </td>
    </tr>
  );
}

/** ISO 타임스탬프를 "MM-DD HH:mm" 로. 목록 컬럼이라 연도는 뺀다. */
function formatStamp(iso: string): string {
  return iso.replace("T", " ").slice(5, 16);
}
