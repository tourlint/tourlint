"use client";

// 장소 정보 한 줄 (FR-PL-005 · UI-S2-024). 고른 곳의 공사 표시값을 한 줄로 보여 준다 —
// 영업시간 · 쉬는 날 · 앞 장소에서 걸리는 시간, 그리고 에이전트가 찾아 준 곳이면 "AI가 찾음".
// 규칙 번호 · 통과 여부 · 등급 색 · 실내 · 야외 배지는 두지 않는다 (판정은 검수의 몫이다).

import type { PlaceFacts } from "../../../../lib/api";

export function PlaceFactsLine({ facts }: { facts: PlaceFacts }) {
  const parts: string[] = [facts.kindName];
  if (facts.hours !== null) parts.push(`영업 ${facts.hours}`);
  if (facts.restDays !== null) parts.push(`쉬는 날 ${facts.restDays}`);
  if (facts.eventPeriod !== null) parts.push(`행사 ${facts.eventPeriod}`);
  if (facts.travelFromPrevMinutes !== null) parts.push(`앞 장소에서 약 ${facts.travelFromPrevMinutes}분`);
  if (facts.matchedBy === "AGENT") parts.push("AI가 찾음");
  return (
    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
      {parts.filter((p) => p !== "").join(" · ")}
    </p>
  );
}
