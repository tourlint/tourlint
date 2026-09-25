"use client";

// 예산이 다 되면 검수 버튼을 누르기 전에 막는다 (UI-ST-007 · EX-QT-002 · #838).
// 모르면(조회 실패) 막지 않는다 — 누르면 서버가 같은 문으로 429 를 준다.

import { useCallback, useEffect, useState } from "react";
import { auditApi, type AuditAvailability } from "./api";

export function useAuditAvailability(): { blocked: boolean; resumesAt: string | null; refresh: () => void } {
  const [state, setState] = useState<AuditAvailability | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    auditApi.availability().then((a) => { if (alive) setState(a); }, () => { /* 모르면 막지 않는다 */ });
    return () => { alive = false; };
  }, [tick]);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { blocked: state !== null && !state.available, resumesAt: state?.resumesAt ?? null, refresh };
}

/** 막힌 자리의 안내 — 사유 · 다시 열리는 때 · 지금 할 수 있는 일 */
export function budgetBlockedText(resumesAt: string | null): string {
  const when = resumesAt === null ? "내일 0시" : `${Number(resumesAt.slice(5, 7))}월 ${Number(resumesAt.slice(8, 10))}일 0시`;
  return `오늘 쓸 수 있는 관광정보 조회를 모두 써서 지금은 검수할 수 없어요. ${when}부터 다시 할 수 있어요. 일정 편집과 지난 결과는 지금도 볼 수 있어요.`;
}

export function AuditBudgetNotice({ resumesAt, className = "" }: { resumesAt: string | null; className?: string }) {
  return (
    <p role="status" data-budget-blocked className={`rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 ${className}`}>
      {budgetBlockedText(resumesAt)}
    </p>
  );
}
