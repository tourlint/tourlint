// 화면 7 · 수요 · 변경 레이더 (UI-S7 · F12~F15). 골격만 — 신선도 신호(T1·T2),
// 변경 목록, 영향 탐색은 후속 작업.
export default function RadarPage() {
  return (
    <>
      <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">수요 · 변경 레이더</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        관광정보 변경과 수요 신호를 감시합니다. (F12~F15)
      </p>

      <div className="mt-10 rounded-2xl border border-dashed border-slate-300 py-16 text-center text-sm text-slate-400 dark:border-slate-700 dark:text-slate-500">
        신선도 신호 · 변경 목록은 다음 단계에서 붙습니다.
      </div>
    </>
  );
}
