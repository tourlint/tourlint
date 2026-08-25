"use client";

// 인증 뒤 홈 (S1 상품 대시보드의 초기 셸).
// 오늘은 로그인 루프를 닫는 데 집중한다 — 로그인 계정 표시 + 로그아웃.
// 상품 목록·호출 예산 위젯·등급 배지는 W2 에서 채운다.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authApi, isApiError, type AccountView } from "./lib/api";

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

export default function HomePage() {
  const router = useRouter();
  const [account, setAccount] = useState<AccountView | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const me = await authApi.me();
        if (!alive) return;
        setAccount(me);
        // 상품 목록은 아직 mock 이다. 세션 쿠키가 함께 나가므로 가드를 통과한다.
        const res = await fetch("/api/v1/products", { credentials: "include" });
        if (alive && res.ok) {
          const json = (await res.json()) as { content?: Product[] };
          setProducts(json.content ?? []);
        }
      } catch (err) {
        // 세션이 없으면 로그인 화면으로 (프록시가 이미 보냈겠지만 방어적으로)
        if (isApiError(err) && err.status === 401) router.replace("/login");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [router]);

  async function onLogout() {
    await authApi.logout().catch(() => undefined);
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="flex flex-1 flex-col bg-slate-50 dark:bg-slate-950">
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <span className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            TourLint
          </span>
          <div className="flex items-center gap-3 text-sm">
            {account && (
              <span className="text-slate-500 dark:text-slate-400">
                {account.email}
                {account.isDemo && (
                  <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
                    데모
                  </span>
                )}
              </span>
            )}
            <button
              onClick={onLogout}
              className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              로그아웃
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">상품 대시보드</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          검수 대상: 당일 ~ 2박 3일 · 최대 구간 12곳
        </p>

        {loading ? (
          <p className="mt-8 text-sm text-slate-400">불러오는 중…</p>
        ) : products.length === 0 ? (
          <p className="mt-8 text-sm text-slate-500 dark:text-slate-400">
            등록된 상품이 없습니다. 상품 등록은 다음 단계에서 붙습니다.
          </p>
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
                    <td className="p-3 font-medium text-slate-900 dark:text-slate-100">{p.name}</td>
                    <td className="p-3 text-slate-600 dark:text-slate-300">
                      {[p.region?.regnName, p.region?.signguName].filter(Boolean).join(" ") || "-"}
                    </td>
                    <td className="p-3 text-slate-600 dark:text-slate-300">{p.startDate}</td>
                    <td className="p-3 text-slate-600 dark:text-slate-300">
                      {NIGHTS_LABEL[p.nights] ?? `${p.nights}박`}
                    </td>
                    <td className="p-3">
                      {a?.isPartial ? (
                        <span className="rounded bg-slate-200 px-2 py-0.5 text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                          부분 검수
                        </span>
                      ) : a?.readinessScore != null ? (
                        <strong className="text-slate-900 dark:text-slate-100">{a.readinessScore}점</strong>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="p-3 tabular-nums text-slate-600 dark:text-slate-300">
                      {a
                        ? `${a.counts.blocker} / ${a.counts.error} / ${a.counts.warning} / ${a.counts.unverified}`
                        : "-"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </main>

      <footer className="border-t border-slate-200 py-4 text-center text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
        출처: ⓒ한국관광공사
      </footer>
    </div>
  );
}
