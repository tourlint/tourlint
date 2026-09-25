"use client";

// 장소 담기 첫 줄 — 종류 목록을 받는 중이거나 못 받았을 때 (#822).
// 못 받았는데 「불러오는 중…」 을 그대로 두면 다시 부를 길이 없다. 등록 화면과 기획 화면이 같이 쓴다.

export function BriefingStatus({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  if (error === null) return <p className="mt-3 text-sm text-slate-400">불러오는 중…</p>;
  return (
    <p role="alert" className="mt-3 text-sm text-rose-600 dark:text-rose-400">
      {error}{" "}
      <button type="button" onClick={onRetry} className="underline underline-offset-2">다시 불러오기</button>
    </p>
  );
}
