// 출시 준비도 계산을 사람 문장으로 (UI-S3-010). "100점에서 주의 2건 −8점, 확인 불가 1건
// −3점" 처럼 감점이 있는 등급만 적는다. 무시(제외)는 별도 문구라 여기서 다루지 않는다.

export interface GradeCounts {
  blocker: number;
  error: number;
  warning: number;
  unverified: number;
}

export interface GradeWeights {
  BLOCKER: number;
  ERROR: number;
  WARNING: number;
  UNVERIFIED: number;
}

const GRADES: { key: keyof GradeCounts; weightKey: keyof GradeWeights; label: string }[] = [
  { key: "blocker", weightKey: "BLOCKER", label: "차단" },
  { key: "error", weightKey: "ERROR", label: "오류" },
  { key: "warning", weightKey: "WARNING", label: "주의" },
  { key: "unverified", weightKey: "UNVERIFIED", label: "확인 불가" },
];

/**
 * 감점 계산 문장. 건수가 0 인 등급은 생략한다. 모두 0 이면 감점 없이 만점이라고 적는다.
 * 준비도가 부분 검수 등으로 산출되지 않았으면(null) 빈 문자열이다 — 화면이 계산을 지어내지 않는다.
 */
export function scoreSentence(counts: GradeCounts, weights: GradeWeights): string {
  const parts = GRADES.flatMap((g) => {
    const n = counts[g.key];
    if (n <= 0) return [];
    return [`${g.label} ${n}건 −${n * weights[g.weightKey]}점`];
  });
  if (parts.length === 0) return "감점 없이 100점";
  return `100점에서 ${parts.join(", ")}`;
}
