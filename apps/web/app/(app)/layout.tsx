import type { ReactNode } from "react";
import { AppHeader } from "../components/app-header";
import { AppFooter } from "../components/app-footer";

// 인증 후 공통 셸 (UI-CM-001) — 전역 헤더 · 본문 · 전역 푸터 3단.
// 로그인 화면(/login)은 이 그룹 밖이라 이 셸을 쓰지 않는다.
// body(min-h-dvh flex-col) 안에서 flex-1 로 늘어나 푸터가 바닥에 붙는다.
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col bg-slate-50 dark:bg-slate-950">
      <AppHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
      <AppFooter />
    </div>
  );
}
