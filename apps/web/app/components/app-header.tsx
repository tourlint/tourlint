"use client";

// 전역 헤더 (UI-CM-002). 인증 후 모든 화면이 공유한다 — 서비스명, 주요 화면 이동
// (대시보드 · 레이더 · 설정), 알림 진입점, 오늘 호출량 위젯, 로그아웃.
// 알림 건수(UI-CM-008)와 호출량 위젯(UI-S1-004)은 뒷단(mock) 연동 전이라 자리만 잡는다.

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { authApi, isApiError, type AccountView } from "../lib/api";

const NAV = [
  { href: "/", label: "대시보드" },
  { href: "/radar", label: "레이더" },
  { href: "/settings", label: "설정" },
] as const;

export function AppHeader() {
  const router = useRouter();
  const pathname = usePathname();
  const [account, setAccount] = useState<AccountView | null>(null);

  useEffect(() => {
    let alive = true;
    authApi
      .me()
      .then((me) => {
        if (alive) setAccount(me);
      })
      .catch((err) => {
        // 세션이 없으면 로그인으로 (프록시가 이미 보냈겠지만 방어적으로)
        if (isApiError(err) && err.status === 401) router.replace("/login");
      });
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
    <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
        <div className="flex items-center gap-6">
          <Link
            href="/"
            className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50"
          >
            TourLint
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            {NAV.map((item) => {
              const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-md px-3 py-1.5 font-medium transition ${
                    active
                      ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-50"
                      : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-3 text-sm">
          {/* 오늘 호출량 위젯 · 알림 진입점 — 뒷단 연동 전 자리만 (UI-S1-004 · UI-CM-002/008) */}
          <span className="hidden rounded-md border border-dashed border-slate-300 px-2 py-1 text-xs text-slate-400 sm:inline dark:border-slate-700 dark:text-slate-500">
            호출량 —
          </span>
          <button
            type="button"
            aria-label="알림"
            className="rounded-md border border-slate-300 px-2 py-1 text-slate-500 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            알림
          </button>
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
  );
}
