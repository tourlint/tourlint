"use client";

// 상품 등록 폼 공용 입력 컨트롤. 로그인 화면과 같은 톤(slate/indigo)을 따른다.

import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

export const controlClass =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-50 dark:placeholder:text-slate-600 dark:disabled:bg-slate-900";

export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1 text-sm font-medium text-slate-700 dark:text-slate-300">
        {label}
        {required && (
          <span className="text-rose-500" aria-hidden>
            *
          </span>
        )}
      </span>
      {children}
      {/* 이 값이 어느 규칙에 쓰이는지 등 (UI-S2-006) */}
      {hint && <span className="mt-1 block text-xs text-slate-400 dark:text-slate-500">{hint}</span>}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={controlClass} />;
}

export function SelectInput(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={controlClass} />;
}

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">{title}</h2>
      {description && <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{description}</p>}
      <div className="mt-5 space-y-4">{children}</div>
    </section>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-grid auto-cols-fr grid-flow-col gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
              active
                ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-50"
                : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
