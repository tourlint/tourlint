"use client";

// 엑셀·CSV 업로드 (UI-S2-001②·002·010·011). 이 방식에서는 일정을 직접 입력하지 않고,
// 지정 양식 예시를 보여준 뒤 파일을 받아 파싱한다. 결과는 폼 상태에 채워지고, 편집은
// '직접 입력' 탭에서 한다 (UI-S2-010 저장 전 편집 가능).

import { useState } from "react";
import { Section } from "./controls";
import type { ItemType } from "./types";

export interface ParsedItemDTO {
  day: number;
  start: string;
  end: string | null;
  place: string;
  itemType: ItemType;
}

interface ParseResultDTO {
  nights: number;
  items: ParsedItemDTO[];
  errors: { row: number; reason: string }[];
  rejected?: { code: string; message: string };
}

// 지정 양식 예시 — 화면에서 형태를 바로 보여준다.
const EXAMPLE: { day: string; start: string; end: string; place: string; type: string }[] = [
  { day: "1", start: "10:00", end: "11:30", place: "오죽헌", type: "관광" },
  { day: "1", start: "12:00", end: "13:00", place: "소나무집초당순두부", type: "식사" },
  { day: "1", start: "21:00", end: "(비움)", place: "세인트존스호텔", type: "숙박" },
];

export function UploadPanel({
  onApplied,
  onEdit,
}: {
  onApplied: (nights: number, items: ParsedItemDTO[]) => void;
  onEdit: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ row: number; reason: string }[]>([]);
  const [rejected, setRejected] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<number | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file === undefined) return;
    setBusy(true);
    setErrors([]);
    setRejected(null);
    setLoaded(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/v1/uploads/schedule", { method: "POST", credentials: "include", body });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { message?: string };
        setRejected(b.message ?? "업로드를 처리할 수 없습니다.");
        return;
      }
      const result = (await res.json()) as ParseResultDTO;
      if (result.rejected) {
        setRejected(result.rejected.message);
        return;
      }
      setErrors(result.errors);
      onApplied(result.nights, result.items);
      setLoaded(result.items.length);
    } catch {
      setRejected("업로드 중 오류가 발생했습니다.");
    } finally {
      setBusy(false);
      e.target.value = ""; // 같은 파일 다시 올릴 수 있게
    }
  }

  return (
    <Section
      title="일정 업로드"
      description="지정 양식(.xlsx) 또는 CSV 로 일정을 한 번에 등록합니다. 아래 예시 형태로 작성하세요."
    >
      {/* 지정 양식 예시 */}
      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-slate-50 text-left text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
              <th className="p-2 font-medium">일차</th>
              <th className="p-2 font-medium">시작시간</th>
              <th className="p-2 font-medium">종료시간</th>
              <th className="p-2 font-medium">장소명</th>
              <th className="p-2 font-medium">유형</th>
            </tr>
          </thead>
          <tbody>
            {EXAMPLE.map((r, i) => (
              <tr key={i} className="border-t border-slate-100 text-slate-600 dark:border-slate-800/60 dark:text-slate-300">
                <td className="p-2">{r.day}</td>
                <td className="p-2 tabular-nums">{r.start}</td>
                <td className="p-2 tabular-nums text-slate-400">{r.end}</td>
                <td className="p-2">{r.place}</td>
                <td className="p-2">{r.type}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-400 dark:text-slate-500">
        유형은 관광 · 식사 · 숙박 · 휴식 · 이동 · 자유 중 하나 · 종료시간은 비우면 기본 체류시간이 자동
        보완됩니다 · 일차는 1부터 박수+1일차까지(최대 2박 3일).
      </p>

      {/* 양식 다운로드 + 파일 업로드 */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500">
          {busy ? "불러오는 중…" : "파일 선택"}
          <input type="file" accept=".xlsx,.csv" className="hidden" disabled={busy} onChange={onFile} />
        </label>
        <a
          href="/api/v1/uploads/template"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          지정 양식 내려받기
        </a>
      </div>

      {loaded !== null && (
        <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          <span>{loaded}개 항목을 불러왔습니다.</span>{" "}
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
          <p className="font-medium">불러오지 못한 행 (정상 행은 반영됨)</p>
          <ul className="mt-1 list-disc pl-5">
            {errors.map((er) => (
              <li key={er.row}>
                {er.row}행 — {er.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}
