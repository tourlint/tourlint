"use client";

// 자연어 붙여넣기 (UI-S2-001③ · 010 · FR-IN-003). 붙여넣은 글을 서버가 LLM 으로 정형화하고,
// 결과는 폼 상태에 채워진 뒤 '직접 입력' 탭에서 편집한다 — 사용자 확인 없이 확정하지 않는다.

import { useState } from "react";
import { Section } from "./controls";
import type { ParsedItemDTO } from "./upload-panel";

interface ParseResultDTO {
  nights: number;
  items: ParsedItemDTO[];
  errors: { row: number; reason: string }[];
  rejected?: { code: string; message: string };
}

/** 붙여넣기 상한. 서버와 같은 값이다 (`NL_MAX_CHARS`) */
const MAX_CHARS = 4000;

const EXAMPLE =
  "1일차 / 10시 오죽헌 들렀다가 / 12시쯤 중앙시장에서 점심 / 2시 안목해변 / 저녁 6시 식사하고 8시 숙소";

export function NlPanel({
  onApplied,
  onEdit,
}: {
  onApplied: (nights: number, items: ParsedItemDTO[]) => void;
  onEdit: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ row: number; reason: string }[]>([]);
  const [rejected, setRejected] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<number | null>(null);

  async function convert() {
    setBusy(true);
    setErrors([]);
    setRejected(null);
    setLoaded(null);
    try {
      const res = await fetch("/api/v1/uploads/schedule-text", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { message?: string };
        setRejected(b.message ?? "변환을 처리할 수 없습니다.");
        return;
      }
      const result = (await res.json()) as ParseResultDTO;
      if (result.rejected) {
        // 서버가 준 단일 문구를 그대로 쓴다 — 화면이 사유를 지어내지 않는다 (EX-SY-004)
        setRejected(result.rejected.message);
        return;
      }
      setErrors(result.errors);
      onApplied(result.nights, result.items);
      setLoaded(result.items.length);
    } catch {
      setRejected("변환 중 오류가 발생했습니다.");
    } finally {
      setBusy(false);
    }
  }

  const tooLong = text.length > MAX_CHARS;

  return (
    <Section
      title="자연어 붙여넣기"
      description="일정을 적어 둔 글을 그대로 붙여넣으면 표로 바꿔 드립니다. 바꾼 결과는 저장 전에 편집할 수 있습니다."
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        placeholder={EXAMPLE}
        className="w-full rounded-lg border border-slate-300 p-3 text-sm text-slate-800 placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={`text-xs ${tooLong ? "text-rose-600 dark:text-rose-400" : "text-slate-400 dark:text-slate-500"}`}>
          {text.length} / {MAX_CHARS}자
        </p>
        <button
          type="button"
          onClick={convert}
          disabled={busy || text.trim() === "" || tooLong}
          aria-busy={busy}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-60"
        >
          {busy ? "바꾸는 중…" : "일정으로 바꾸기"}
        </button>
      </div>
      <p className="text-xs text-slate-400 dark:text-slate-500">
        적혀 있지 않은 시각과 장소는 채우지 않습니다 · 종료시간이 없으면 기본 체류시간이 자동
        보완됩니다 · 일차는 1부터 박수+1일차까지(최대 2박 3일).
      </p>

      {loaded !== null && (
        <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          <span>{loaded}개 항목으로 바꿨습니다.</span>{" "}
          <button type="button" onClick={onEdit} className="font-semibold underline underline-offset-2">
            직접 입력에서 편집
          </button>
        </div>
      )}
      {rejected !== null && (
        <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
          {rejected}
        </p>
      )}
      {errors.length > 0 && (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <p className="font-medium">바꾸지 못한 항목 (나머지는 반영됨)</p>
          <ul className="mt-1 list-disc pl-5">
            {errors.map((er) => (
              <li key={er.row}>
                {er.row}번째 — {er.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}
