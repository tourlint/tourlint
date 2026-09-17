"use client";

// 전역 헤더 (UI-CM-002). 홈과 세 업무 화면(기획 → 검수 → 레이더)을 분리한다.
// 검수 기준은 보조로 둔다. 오늘 호출량은 헤더에
// 상시로 두지 않고 계정 메뉴 "오늘 사용량"에서만 본다 (UI-S1-004 · PM-DA-006).

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  authApi,
  isApiError,
  usageApi,
  type AccountView,
  type BudgetView,
} from "../lib/api";

import { MAIN_NAV, activeSection } from "../lib/workspace";
import { WorkspaceIcon } from "./workspace-icon";

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

  return (
    <header className="app-header">
      <a href="#main-content" className="skip-link">
        본문으로 건너뛰기
      </a>
      <div className="header-inner">
        <Link href="/" className="brand" aria-label="TourLint 홈">
          <span className="brand-mark">
            <WorkspaceIcon name="check" width="22" height="22" />
          </span>
          TourLint
          <span className="brand-divider" />
        </Link>
        <nav className="main-nav" aria-label="주 메뉴">
          {MAIN_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={
                activeSection(pathname) === item.href ? "page" : undefined
              }
            >
              <WorkspaceIcon name={item.icon} />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="header-tools">
          <Link
            href="/standard"
            className="standard-link"
            aria-current={pathname.startsWith("/standard") ? "page" : undefined}
          >
            <WorkspaceIcon name="book" width="17" height="17" />
            <span>검수 기준</span>
          </Link>
          <Link
            href="/radar#notifications"
            className="notification-link"
            aria-label="알림"
            title="레이더 알림 보기"
          >
            <WorkspaceIcon name="bell" />
          </Link>
          <AccountMenu account={account} onLogout={() => void logout(router)} />
        </div>
      </div>
    </header>
  );
}

async function logout(router: ReturnType<typeof useRouter>): Promise<void> {
  await authApi.logout().catch(() => undefined);
  router.replace("/login");
  router.refresh();
}

/**
 * 계정 메뉴. 이메일을 누르면 열리고, 오늘 사용량과 로그아웃을 담는다. 오늘 호출량을 헤더에
 * 상시로 두지 않는 이유 — 예산은 서비스 전체 단일 인증키 기준이라 상시 노출이 계정 정보처럼
 * 읽힌다 (PM-DA-006). 사용량은 열어 볼 때 한 번 읽는다.
 */
function AccountMenu({
  account,
  onLogout,
}: {
  account: AccountView | null;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={account ? `${account.email} 계정 메뉴` : "계정 메뉴"}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        className="account-trigger"
      >
        <span className="account-avatar" aria-hidden="true">
          {account?.email.slice(0, 1).toUpperCase() ?? "T"}
        </span>
        <span className="account-email max-w-[12rem] truncate">
          {account?.email ?? "계정"}
        </span>
        {account?.isDemo === true && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
            데모
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-56 rounded-lg border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-800 dark:bg-slate-900">
          <UsageRow />
          <button
            type="button"
            onClick={onLogout}
            className="mt-1 w-full rounded-md px-3 py-1.5 text-left text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            로그아웃
          </button>
        </div>
      )}
    </div>
  );
}

const BUDGET_TONE: Record<BudgetView["state"], string> = {
  NORMAL: "text-slate-500 dark:text-slate-400",
  WARN: "text-amber-700 dark:text-amber-300",
  EXHAUSTED: "text-red-700 dark:text-red-300",
};

/**
 * 오늘 공사 호출 사용량 (UI-S1-004 · F15). 계정 메뉴를 열 때 한 번 읽는다. 조회 실패해도
 * 메뉴는 죽지 않는다.
 */
function UsageRow() {
  const [budget, setBudget] = useState<BudgetView | null>(null);

  useEffect(() => {
    let alive = true;
    usageApi
      .budget()
      .then((b) => {
        if (alive) setBudget(b);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="rounded-md px-3 py-1.5">
      <p className="text-xs text-slate-400">오늘 사용량</p>
      {budget === null ? (
        <p className="text-sm text-slate-400">—</p>
      ) : (
        <p
          className={`text-sm font-medium tabular-nums ${BUDGET_TONE[budget.state]}`}
        >
          {budget.used}/{budget.dailyQuota}
          <span className="ml-1 text-xs font-normal text-slate-400">
            ({Math.round(budget.usageRatio * 100)}%)
          </span>
        </p>
      )}
    </div>
  );
}
