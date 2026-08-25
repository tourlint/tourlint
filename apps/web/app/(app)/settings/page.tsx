// 화면 8 · 설정 (UI-S8 · F16). 골격만 — 계정 · 알림 · 검수 기본값 설정은 후속 작업.
export default function SettingsPage() {
  return (
    <>
      <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">설정</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        계정과 검수 기본값을 관리합니다. (F16)
      </p>

      <div className="mt-10 rounded-2xl border border-dashed border-slate-300 py-16 text-center text-sm text-slate-400 dark:border-slate-700 dark:text-slate-500">
        설정 항목은 다음 단계에서 붙습니다.
      </div>
    </>
  );
}
