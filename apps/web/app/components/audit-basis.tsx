"use client";

// 검수 근거 영역 (UI-CM-030 · 031).
//
// 검수 결과가 표시되는 화면(3 · 4 · 5 · 7)과 PDF 하단에 고정 표시한다. 화면마다 근거로
// 삼는 것이 달라서 줄은 호출자가 준다 — 없는 값을 이 컴포넌트가 지어내지 않는다.

import { useState } from "react";

export interface BasisRow {
  label: string;
  value: string;
  /** 축약해 보이고 클릭하면 전체를 펼친다 (UI-CM-032) */
  full?: string | null;
}

export const DELAY_NOTICE =
  "공사 데이터는 당일 변경분이 익일 반영되므로 출발 임박 시 운영기관 최종 확인을 권장합니다";
export const SOURCE_NOTICE = "출처: ⓒ한국관광공사";

export function AuditBasis({
  rows,
  notice = DELAY_NOTICE,
  source = SOURCE_NOTICE,
}: {
  rows: BasisRow[];
  notice?: string | null;
  source?: string;
}) {
  return (
    <dl className="mt-4 grid gap-1 border-t border-slate-100 pt-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {rows.map((r) => (
          <BasisItem key={r.label} row={r} />
        ))}
      </div>
      {notice !== null && <p className="mt-1">{notice}</p>}
      <p>{source}</p>
    </dl>
  );
}

function BasisItem({ row }: { row: BasisRow }) {
  const [open, setOpen] = useState(false);
  const expandable = row.full != null && row.full !== "" && row.full !== row.value;

  return (
    <span className="flex gap-1">
      <dt>{row.label}</dt>
      <dd className="text-slate-600 dark:text-slate-300">
        {expandable ? (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            title="전체 값 보기"
            className="font-mono underline-offset-2 hover:underline"
          >
            {open ? row.full : row.value}
          </button>
        ) : (
          row.value
        )}
      </dd>
    </span>
  );
}

/**
 * 검수 실행 하나의 근거 줄 (UI-CM-031 일곱 항목 중 표 부분).
 *
 * 화면 3 · 4 · 5 가 같은 줄을 보여야 해서 여기서 만든다.
 */
export function basisRows(e: {
  fetchedAt: string;
  targetContentCount: number;
  dataFingerprint: string | null;
  dataFingerprintFull: string | null;
  rulesetVersion: string;
  ktoModifiedAt: string | null;
}): BasisRow[] {
  return [
    { label: "조회 시각", value: e.fetchedAt.replace("T", " ").slice(0, 16) },
    { label: "대상 콘텐츠", value: `${e.targetContentCount}곳` },
    { label: "데이터 지문", value: e.dataFingerprint ?? "산출하지 않음", full: e.dataFingerprintFull },
    { label: "규칙셋", value: e.rulesetVersion },
    { label: "데이터 최종 수정일", value: ktoDate(e.ktoModifiedAt) },
  ];
}

/** 공사 원문 `YYYYMMDDHHmmss` 를 날짜까지만 읽는다. 변환하지 않고 잘라서 보인다 */
export function ktoDate(raw: string | null | undefined): string {
  if (raw == null || raw.length < 8) return "알 수 없음";
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}
