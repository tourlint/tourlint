"use client";

// 화면 8 · 검수 기준 (UI-S8 · F16 · FR-OP-020~027). 표준(읽기)과 회사 기준(엄격하게만
// 편집), 변경 이력, 규칙 설명을 본다. 표준 표 3종은 @tourlint/shared 시드를 직접 읽어
// 공사 호출 0콜이다. 규칙을 끄고 켜는 수단은 두지 않는다 (PM-NG-003).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Section } from "../products/new/controls";
import { isApiError, settingsApi, type SettingsView, type StandardView } from "../../lib/api";
import { CompanyForm } from "./company-form";
import { RulesPanel } from "./rules-panel";
import { STANDARD_HISTORY, companyCriteriaInEffect } from "./standard-history";
import { PlaceKindTable } from "../settings/tables";
import { ProfileGrid } from "../settings/profiles";

const SEVERITY_LABEL: { key: keyof SettingsView["standard"]["weights"]; label: string }[] = [
  { key: "BLOCKER", label: "차단" },
  { key: "ERROR", label: "오류" },
  { key: "WARNING", label: "주의" },
  { key: "UNVERIFIED", label: "확인 불가" },
];

/** 산식 예시에 쓰는 건수 — 체험 가이드 13단계의 85점과 같은 구성이다 */
const EXAMPLE_COUNTS: Readonly<Record<keyof StandardView["weights"], number>> = { BLOCKER: 0, ERROR: 0, WARNING: 3, UNVERIFIED: 1 };

export default function StandardPage() {
  const router = useRouter();
  const [view, setView] = useState<SettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    settingsApi
      .get()
      .then((v) => {
        if (alive) {
          setView(v);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (isApiError(err) && err.status === 401) {
          router.replace("/login");
          return;
        }
        if (alive) {
          setError(isApiError(err) ? err.message : "검수 기준을 불러오지 못했습니다.");
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [router]);

  if (loading) return <p className="mt-8 text-sm text-slate-400">불러오는 중…</p>;
  if (view === null) {
    return (
      <div className="mt-8 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
        {error ?? "검수 기준을 불러오지 못했습니다."}
      </div>
    );
  }

  const s = view.standard;

  return (
    <>
      <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">검수 기준</h1>
      {/* 지금 적용 중인 것 (UI-S8-002) — 회사 기준은 표준보다 엄격하게 정한 것만 센다 */}
      <p className="mt-2 inline-flex rounded-md bg-slate-100 px-2.5 py-1 text-sm font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200" data-standard-status>
        표준 {s.version} · 회사 기준 {companyCriteriaInEffect(view.company, s)}개 적용 중
      </p>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
        모든 계정에 같은 표준과, 우리 회사가 더 엄격하게 정한 기준을 봅니다. 회사 기준 변경은 <strong>다음 검수부터</strong> 적용되며 과거 결과에 소급되지 않습니다.
      </p>

      <div className="mt-6 space-y-6">
        <Section title={`표준 · ${s.version}`}>
          <dl className="grid gap-3 sm:grid-cols-2">
            <Readonly label="출시 준비도 — 등급별 감점" wide>
              <ScoreFormula standard={s} />
            </Readonly>
            <Readonly label="종류 쏠림 기준" code="R04">같은 유형 {s.r04Threshold}곳 이상</Readonly>
            <Readonly label="연속 일정 기준 시간" code="R07">{s.r07SpanHours}시간</Readonly>
            <Readonly label="최소 식사 시간" code="R07">{s.r07MealMinutes}분</Readonly>
          </dl>
          <p className="mt-2 text-xs text-slate-400">표준 값은 모든 계정에 같으며 바꿀 수 없습니다.</p>
        </Section>

        <Section title="회사 기준">
          <CompanyForm company={view.company} standard={s} onSaved={setView} />
        </Section>

        <Section title="규칙 설명">
          <RulesPanel />
        </Section>

        <Section title="장소 종류별 기본 체류시간 · 실내 · 야외 (표준)">
          <PlaceKindTable />
        </Section>
        <Section title="타깃 · 콘셉트별 기대 구성 (표준)">
          <ProfileGrid />
        </Section>

        <Section title="표준 변경 이력">
          <StandardHistory />
        </Section>
      </div>
    </>
  );
}

/**
 * 출시 준비도 산식과 예시 (UI-S8-003). 가중치는 입력칸이 아니라 계산으로 보인다 — 모든 계정이 같다.
 * 숫자는 표준 응답의 가중치에서 만든다. 화면에 따로 적으면 상수와 어긋난다.
 */
export function ScoreFormula({ standard: s }: { standard: StandardView }) {
  const w = s.weights;
  const counts = EXAMPLE_COUNTS;
  const used = SEVERITY_LABEL.filter((sev) => counts[sev.key] > 0);
  const deducted = used.reduce((sum, sev) => sum + w[sev.key] * counts[sev.key], 0);
  return (
    <>
      <span className="block" data-score-formula>
        100 − ({SEVERITY_LABEL.map((sev) => `${sev.label} ${w[sev.key]}`).join(" · ")} × 건수), 0점 아래로 내려가지 않아요
      </span>
      <span className="mt-1 block text-xs font-normal text-slate-500 dark:text-slate-400" data-score-example>
        예: {used.map((sev) => `${sev.label} ${counts[sev.key]}건`).join(" · ")} → 100 − ({used.map((sev) => `${w[sev.key]} × ${counts[sev.key]}`).join(" + ")}) = {Math.max(0, 100 - deducted)}점
      </span>
    </>
  );
}

function Readonly({ label, code, wide = false, children }: { label: string; code?: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={`rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800 ${wide ? "sm:col-span-2" : ""}`}>
      <dt className="text-xs text-slate-400">
        {label}
        {/* 규칙 코드는 이름 뒤에 작게 (UI-S8-004) */}
        {code !== undefined && <span className="ml-1 font-mono text-[10px] text-slate-300 dark:text-slate-500">{code}</span>}
      </dt>
      <dd className="mt-0.5 text-sm font-medium text-slate-800 dark:text-slate-100">{children}</dd>
    </div>
  );
}

/** 표준 변경 이력 (UI-S8-009). 최신이 위다 */
export function StandardHistory() {
  return (
    <ul className="space-y-1.5 text-xs text-slate-500 dark:text-slate-400" data-standard-history>
      {[...STANDARD_HISTORY].reverse().map((h) => (
        <li key={h.version} className="leading-relaxed">
          <span className="font-medium tabular-nums text-slate-700 dark:text-slate-200">{h.date} · 표준 {h.version}</span>
          <span className="ml-1.5">{h.summary}</span>
        </li>
      ))}
    </ul>
  );
}
