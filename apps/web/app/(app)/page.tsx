"use client";

// 화면 1 · 상품 대시보드 (UI-S1). 허브 화면 — 여기서 신규 등록(/products/new)과
// 상품 선택(→ 검수 결과 /products/:id)으로 분기한다. 헤더·푸터는 (app)/layout 이 준다.
// 예산 위젯 · 등급 배지 · 출시 불가 배지 · 정렬 등 UI-S1 세부는 후속 작업에서 채운다.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isApiError } from "../lib/api";
import { GradeCounts, StatusBadge } from "../components/badges";

interface Product {
  productId: number;
  name: string;
  startDate: string;
  nights: number;
  region?: { regnName?: string; signguName?: string };
  latestAudit?: {
    readinessScore: number | null;
    isPartial: boolean;
    counts: { blocker: number; error: number; warning: number; unverified: number };
  };
}

const NIGHTS_LABEL = ["당일", "1박 2일", "2박 3일"];

export default function DashboardPage() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // 상품 목록은 아직 mock 이다. 세션 쿠키가 함께 나가므로 가드를 통과한다.
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

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">상품 대시보드</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            검수 대상: 당일 ~ 2박 3일 · 최대 구간 12곳
          </p>
        </div>
        {/* 신규 상품 등록 진입점 (UI-S1-006) */}
        <Link
          href="/products/new"
          className="shrink-0 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
        >
          신규 등록
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
        <table className="mt-6 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500 dark:border-slate-800 dark:text-slate-400">
              <th className="p-3 font-medium">상품명</th>
              <th className="p-3 font-medium">지역</th>
              <th className="p-3 font-medium">출발일</th>
              <th className="p-3 font-medium">일정</th>
              <th className="p-3 font-medium">출시 준비도</th>
              <th className="p-3 font-medium">차단/오류/주의/확인불가</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => {
              const a = p.latestAudit;
              return (
                <tr key={p.productId} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="p-3 font-medium">
                    {/* 상품 선택 → 검수 결과 (UI-S1-001 · 화면 전이 1→3) */}
                    <Link
                      href={`/products/${p.productId}`}
                      className="text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      {p.name}
                    </Link>
                  </td>
                  <td className="p-3 text-slate-600 dark:text-slate-300">
                    {[p.region?.regnName, p.region?.signguName].filter(Boolean).join(" ") || "-"}
                  </td>
                  <td className="p-3 text-slate-600 dark:text-slate-300">{p.startDate}</td>
                  <td className="p-3 text-slate-600 dark:text-slate-300">
                    {NIGHTS_LABEL[p.nights] ?? `${p.nights}박`}
                  </td>
                  <td className="p-3">
                    {a?.isPartial ? (
                      <StatusBadge status="PARTIAL" />
                    ) : a?.readinessScore != null ? (
                      <strong className="text-slate-900 dark:text-slate-100">{a.readinessScore}점</strong>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="p-3">
                    {a ? <GradeCounts counts={a.counts} variant="chip" /> : <span className="text-slate-400">-</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
