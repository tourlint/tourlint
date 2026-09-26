"use client";

// 회사 기준 (FR-OP-022 · 026). 표준보다 엄격하게만 정하는 R07 두 값과 그 변경 이력.
// 입력은 화면이 먼저 검증하고, 서버도 400 SETTING_NOT_STRICTER 로 막는다.

import { useState } from "react";
import { Field, TextInput } from "../products/new/controls";
import { isApiError, settingsApi, type CompanyView, type SettingsView, type StandardView } from "../../lib/api";
import { hasCompanyErrors, strictnessLabel, validateCompanyDraft } from "./company-settings";

const FIELD_LABEL: Record<CompanyView["history"][number]["field"], string> = {
  r07SpanHours: "연속 일정 기준 시간",
  r07MealMinutes: "최소 식사 시간",
};

export function CompanyForm({
  company,
  standard,
  onSaved,
}: {
  company: CompanyView;
  standard: StandardView;
  onSaved: (v: SettingsView) => void;
}) {
  const [spanHours, setSpanHours] = useState(company.r07SpanHours);
  const [mealMinutes, setMealMinutes] = useState(company.r07MealMinutes);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const fieldErrors = validateCompanyDraft({ r07SpanHours: spanHours, r07MealMinutes: mealMinutes });
  const dirty = spanHours !== company.r07SpanHours || mealMinutes !== company.r07MealMinutes;

  async function save() {
    if (hasCompanyErrors(fieldErrors) || !dirty) return;
    setSaving(true);
    setServerError(null);
    setSaved(false);
    try {
      const v = await settingsApi.update({ r07SpanHours: spanHours, r07MealMinutes: mealMinutes });
      onSaved(v);
      setSaved(true);
    } catch (err) {
      // 서버가 준 사유 문구를 그대로 보여 준다 (화면이 사유를 지어내지 않는다)
      setServerError(isApiError(err) ? err.message : "저장에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <p className="text-xs text-slate-400">
        표준보다 <strong>엄격하게만</strong> 정할 수 있습니다 — 연속 일정은 표준 {standard.r07SpanHours}시간 이하, 식사는 표준 {standard.r07MealMinutes}분 이상. 바꾼 값은 다음 검수부터 적용되고 과거 결과는 그대로입니다.
      </p>

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <Field label="연속 일정 기준 시간" hint={`표준 ${standard.r07SpanHours}시간`}>
          <div className="flex items-center gap-2">
            <TextInput
              type="number"
              value={spanHours}
              onChange={(e) => {
                setSaved(false);
                setSpanHours(Number(e.target.value));
              }}
              className="w-full"
            />
            <span className="shrink-0 text-sm text-slate-400">시간</span>
          </div>
          {fieldErrors.r07SpanHours && (
            <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{fieldErrors.r07SpanHours}</p>
          )}
          <StrictnessTag label={strictnessLabel(spanHours, standard.r07SpanHours, fieldErrors.r07SpanHours)} />
        </Field>

        <Field label="최소 식사 시간" hint={`표준 ${standard.r07MealMinutes}분`}>
          <div className="flex items-center gap-2">
            <TextInput
              type="number"
              value={mealMinutes}
              onChange={(e) => {
                setSaved(false);
                setMealMinutes(Number(e.target.value));
              }}
              className="w-full"
            />
            <span className="shrink-0 text-sm text-slate-400">분</span>
          </div>
          {fieldErrors.r07MealMinutes && (
            <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{fieldErrors.r07MealMinutes}</p>
          )}
          <StrictnessTag label={strictnessLabel(mealMinutes, standard.r07MealMinutes, fieldErrors.r07MealMinutes)} />
        </Field>
      </div>

      {/* 느슨하게 보는 길은 건별 무시뿐이다 (UI-S8-006 · FR-OP-022 · 기능설명서 차별성 5) */}
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400" data-loosen-guide>
        표준보다 느슨하게는 정할 수 없어요. 어떤 상품에서 기준을 느슨하게 봐야 하면 그 상품의 검수 결과에서 해당 항목에 사유를 달아 무시해 주세요. 차단은 무시할 수 없어요.
      </p>

      <div className="mt-3 flex items-center justify-end gap-3">
        {serverError && <span className="mr-auto text-sm text-rose-600 dark:text-rose-400">{serverError}</span>}
        {saved && !serverError && (
          <span className="mr-auto text-sm text-emerald-600 dark:text-emerald-400">저장했습니다. 다음 검수부터 적용됩니다.</span>
        )}
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty || hasCompanyErrors(fieldErrors)}
          className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "저장 중…" : "저장"}
        </button>
      </div>

      {company.history.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400">변경 이력</h3>
          <ul className="mt-1 space-y-1 text-xs text-slate-500 dark:text-slate-400">
            {[...company.history].reverse().map((h, i) => (
              <li key={`${h.at}-${i}`} className="tabular-nums">
                {formatStamp(h.at)} · {FIELD_LABEL[h.field]} {h.from} → {h.to}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function formatStamp(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}

/** 칸 아래 「표준과 같음 / 표준보다 엄격」 (UI-S8-006) */
function StrictnessTag({ label }: { label: string | null }) {
  if (label === null) return null;
  return (
    <span className={`mt-1 block text-xs font-medium ${label === "표준보다 엄격" ? "text-indigo-600 dark:text-indigo-300" : "text-slate-500 dark:text-slate-400"}`} data-strictness>
      {label}
    </span>
  );
}
