"use client";

// 화면 8 · 검수 기준 (UI-S8 · F16 · FR-OP-020~027). 표준(읽기)과 회사 기준(엄격하게만
// 편집), 변경 이력, 규칙 설명을 본다. 표준 표 3종은 @tourlint/shared 시드를 직접 읽어
// 공사 호출 0콜이다. 규칙을 끄고 켜는 수단은 두지 않는다 (PM-NG-003).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Section } from "../products/new/controls";
import { isApiError, settingsApi, type SettingsView } from "../../lib/api";
import { CompanyForm } from "./company-form";
import { RulesPanel } from "./rules-panel";
import { DwellTable, IndoorOutdoorTable } from "../settings/tables";
import { ProfileEditor } from "../settings/profiles";

const SEVERITY_LABEL: { key: keyof SettingsView["standard"]["weights"]; label: string }[] = [
  { key: "BLOCKER", label: "차단" },
  { key: "ERROR", label: "오류" },
  { key: "WARNING", label: "주의" },
  { key: "UNVERIFIED", label: "확인 불가" },
];

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
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        모든 계정에 같은 표준과, 우리 회사가 더 엄격하게 정한 기준을 봅니다. 회사 기준 변경은 <strong>다음 검수부터</strong> 적용되며 과거 결과에 소급되지 않습니다.
      </p>

      <div className="mt-6 space-y-6">
        <Section title={`표준 · ${s.version}`}>
          <dl className="grid gap-3 sm:grid-cols-2">
            <Readonly label="출시 준비도 가중치 (등급별 감점)">
              {SEVERITY_LABEL.map((sev) => `${sev.label} ${s.weights[sev.key]}`).join(" · ")}
            </Readonly>
            <Readonly label="유형 편중 임계치 (R04)">같은 유형 {s.r04Threshold}곳 이상</Readonly>
            <Readonly label="연속 일정 기준 시간 (R07)">{s.r07SpanHours}시간</Readonly>
            <Readonly label="최소 식사 시간 (R07)">{s.r07MealMinutes}분</Readonly>
          </dl>
          <p className="mt-2 text-xs text-slate-400">표준 값은 모든 계정에 같으며 바꿀 수 없습니다.</p>
        </Section>

        <Section title="회사 기준">
          <CompanyForm company={view.company} standard={s} onSaved={setView} />
        </Section>

        <Section title="규칙 설명">
          <RulesPanel />
        </Section>

        <Section title="중분류별 기본 체류시간 (표준)">
          <DwellTable />
        </Section>
        <Section title="중분류별 실내 · 야외 (표준)">
          <IndoorOutdoorTable />
        </Section>
        <Section title="R10 기대 콘텐츠 프로파일 (표준)">
          <ProfileEditor />
        </Section>
      </div>
    </>
  );
}

function Readonly({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-slate-800 dark:text-slate-100">{children}</dd>
    </div>
  );
}
