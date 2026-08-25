"use client";

// S0 인증 (UI-S0-001~006 · FR-CM-001~002).
// 로그인/회원가입을 한 화면에서 전환한다. 입력은 이메일+비밀번호뿐 —
// 이름·소속·연락처를 요구하지 않고(PM-AC-009), 비밀번호 재설정·소셜 로그인
// 진입점을 두지 않는다(UI-S0-006).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authApi, isApiError } from "../lib/api";

type Mode = "login" | "signup";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await authApi.login(email, password);
      else await authApi.signup(email, password);
      router.replace("/");
      router.refresh();
    } catch (err) {
      // 서버가 준 단일 문구를 그대로 보여준다 — 아이디 없음/비밀번호 불일치를 구분하지 않는다
      setError(isApiError(err) ? err.message : "요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.");
      setBusy(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center bg-slate-50 px-4 py-12 dark:bg-slate-950">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mb-3 inline-flex items-center gap-2">
            <LintMark />
            <span className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
              TourLint
            </span>
          </div>
          {/* 서비스 설명 한 문장 (UI-S0-004) */}
          <p className="text-sm text-slate-500 dark:text-slate-400">
            출시 전 여행상품을 관광정보로 검수합니다.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-8">
          {/* 로그인 / 회원가입 전환 (UI-S0-001) */}
          <div
            role="tablist"
            aria-label="로그인 또는 회원가입"
            className="mb-6 grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800"
          >
            <SegButton active={mode === "login"} onClick={() => switchMode("login")}>
              로그인
            </SegButton>
            <SegButton active={mode === "signup"} onClick={() => switchMode("signup")}>
              회원가입
            </SegButton>
          </div>

          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <Field
              label="이메일"
              type="email"
              value={email}
              autoComplete="email"
              placeholder="you@example.com"
              onChange={setEmail}
            />
            <Field
              label="비밀번호"
              type="password"
              value={password}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              placeholder={mode === "signup" ? "8자 이상" : "비밀번호"}
              onChange={setPassword}
            />

            {error !== null && (
              <p
                role="alert"
                className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300"
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "처리 중…" : mode === "login" ? "로그인" : "회원가입"}
            </button>
          </form>
        </div>

        {/* 출처 표기 (UI-S0-005 · FR-CM-009) — 텍스트만, 로고 이미지 금지 */}
        <p className="mt-6 text-center text-xs text-slate-400 dark:text-slate-500">
          출처: ⓒ한국관광공사
        </p>
      </div>
    </main>
  );
}

function SegButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
        active
          ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-50"
          : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  type,
  value,
  placeholder,
  autoComplete,
  onChange,
}: {
  label: string;
  type: string;
  value: string;
  placeholder?: string;
  autoComplete?: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-50 dark:placeholder:text-slate-600"
      />
    </label>
  );
}

/** 린트 은유를 담은 마크 — 체크된 목록. 로고 이미지가 아니라 인라인 SVG 라 저작권 이슈 없음 */
function LintMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" className="fill-indigo-600" />
      <path
        d="M8 12.5l2.5 2.5 5-5.5"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
