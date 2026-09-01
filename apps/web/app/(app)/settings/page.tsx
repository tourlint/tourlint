"use client";

// 화면 8 · 설정 (UI-S8 · F16). 단일 페이지 폼(UI-S8-001). 계정 설정(가중치·R07·R04·관심
// 키워드)을 조회·저장하고, 각 항목에 현재값·기본값·항목별 복원을 준다(UI-S8-003). 전역
// 설정(배치 시각·일일 예산)은 서비스 전체 공통이라 여기서는 조회만 한다. 규칙 개별
// 비활성화 토글은 두지 않는다(UI-S8-008).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Field, Section, TextInput } from "../products/new/controls";
import { isApiError, settingsApi, type AccountSettings, type SettingsView } from "../../lib/api";

const SEVERITIES: { key: keyof AccountSettings["weights"]; label: string }[] = [
  { key: "BLOCKER", label: "차단" },
  { key: "ERROR", label: "오류" },
  { key: "WARNING", label: "주의" },
  { key: "UNVERIFIED", label: "확인 불가" },
];

const NUM_FIELDS: {
  key: "r07SpanHours" | "r07MealMinutes" | "r04Threshold";
  label: string;
  unit: string;
  hint: string;
}[] = [
  { key: "r07SpanHours", label: "R07 연속 일정 기준 시간", unit: "시간", hint: "R07 과밀 일정 판정에 쓰입니다." },
  { key: "r07MealMinutes", label: "R07 최소 식사 시간", unit: "분", hint: "R07 식사 시간 부족 판정에 쓰입니다." },
  { key: "r04Threshold", label: "R04 편중 임계치", unit: "", hint: "R04 유형 편중 판정에 쓰입니다." },
];

export default function SettingsPage() {
  const router = useRouter();
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<AccountSettings | null>(null);
  const [keywordText, setKeywordText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const v = await settingsApi.get();
        if (alive) {
          setView(v);
          setDraft(v.account);
          setKeywordText(v.account.watchKeywords.join(", "));
        }
      } catch (err) {
        if (isApiError(err) && err.status === 401) {
          router.replace("/login");
          return;
        }
        if (alive) setError(isApiError(err) ? err.message : "설정을 불러오지 못했습니다.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [router]);

  function setNum(key: (typeof NUM_FIELDS)[number]["key"], v: number) {
    setSaved(false);
    setDraft((d) => (d === null ? d : { ...d, [key]: v }));
  }
  function setWeight(sev: keyof AccountSettings["weights"], v: number) {
    setSaved(false);
    setDraft((d) => (d === null ? d : { ...d, weights: { ...d.weights, [sev]: v } }));
  }

  async function onSave() {
    if (draft === null) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    const keywords = [...new Set(keywordText.split(",").map((k) => k.trim()).filter((k) => k !== ""))];
    try {
      const v = await settingsApi.update({ ...draft, watchKeywords: keywords });
      setView(v);
      setDraft(v.account);
      setKeywordText(v.account.watchKeywords.join(", "));
      setSaved(true);
    } catch (err) {
      if (isApiError(err) && err.status === 401) {
        router.replace("/login");
        return;
      }
      // 서버가 준 범위 위반 문구를 그대로 보여 준다 (화면이 사유를 지어내지 않는다)
      setError(isApiError(err) ? err.message : "저장에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="mt-8 text-sm text-slate-400">불러오는 중…</p>;
  if (view === null || draft === null) {
    return (
      <div className="mt-8 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
        {error ?? "설정을 불러오지 못했습니다."}
      </div>
    );
  }

  const def = view.defaults.account;

  return (
    <>
      <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">설정</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        계정 검수 기본값을 관리합니다. 변경은 <strong>다음 검수부터</strong> 적용되며 과거 결과에 소급되지 않습니다. (UI-S8-007)
      </p>

      <div className="mt-6 space-y-6">
        <Section title="출시 준비도 가중치">
          <p className="text-xs text-slate-400">등급별 감점 가중치입니다. 준비도 = 100 − Σ(등급 건수 × 가중치).</p>
          <div className="grid gap-3 sm:grid-cols-4">
            {SEVERITIES.map((s) => (
              <NumberField
                key={s.key}
                label={s.label}
                value={draft.weights[s.key]}
                def={def.weights[s.key]}
                onChange={(v) => setWeight(s.key, v)}
                onRestore={() => setWeight(s.key, def.weights[s.key])}
              />
            ))}
          </div>
        </Section>

        <Section title="규칙 기준값">
          {NUM_FIELDS.map((f) => (
            <NumberField
              key={f.key}
              label={f.label}
              unit={f.unit}
              hint={f.hint}
              value={draft[f.key]}
              def={def[f.key]}
              onChange={(v) => setNum(f.key, v)}
              onRestore={() => setNum(f.key, def[f.key])}
            />
          ))}
        </Section>

        <Section title="관심 키워드">
          <Field label="키워드" hint="레이더 수요 신호에서 눈여겨볼 키워드입니다. 쉼표로 구분합니다.">
            <TextInput
              value={keywordText}
              placeholder="예: 강릉, 벚꽃, 야시장"
              onChange={(e) => {
                setSaved(false);
                setKeywordText(e.target.value);
              }}
            />
          </Field>
        </Section>

        {/* 전역 설정 — 서비스 전체 공통. 조회만 (UI-S8-002). */}
        <Section title="서비스 전체 기준 (전역)">
          <p className="text-xs text-slate-400">
            배치 실행 시각과 일일 호출 예산은 전 계정이 공유하는 전역 값입니다. 이 화면에서는 조회만 합니다.
          </p>
          <dl className="grid gap-3 sm:grid-cols-2">
            <ReadonlyRow label="배치 실행 시각" value={view.global.batchTime} />
            <ReadonlyRow label="일일 호출 예산" value={`${view.global.dailyQuota.toLocaleString()}건`} />
          </dl>
        </Section>

        {error && (
          <p role="alert" className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
            {error}
          </p>
        )}
        {saved && (
          <p className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            저장했습니다. 다음 검수부터 적용됩니다.
          </p>
        )}

        <div className="flex justify-end">
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>
    </>
  );
}

function NumberField({
  label,
  unit = "",
  hint,
  value,
  def,
  onChange,
  onRestore,
}: {
  label: string;
  unit?: string;
  hint?: string;
  value: number;
  def: number;
  onChange: (v: number) => void;
  onRestore: () => void;
}) {
  const dirty = value !== def;
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <TextInput
          type="number"
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full"
        />
        {unit && <span className="shrink-0 text-sm text-slate-400">{unit}</span>}
      </div>
      <p className="mt-1 flex items-center gap-2 text-xs text-slate-400">
        기본값 {def}
        {unit}
        {dirty && (
          <button
            type="button"
            onClick={onRestore}
            className="rounded border border-slate-300 px-1.5 py-0.5 font-medium text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            기본값 복원
          </button>
        )}
      </p>
    </Field>
  );
}

function ReadonlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-slate-800 tabular-nums dark:text-slate-100">{value}</dd>
    </div>
  );
}
