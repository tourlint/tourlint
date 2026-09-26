import type { Severity } from '@tourlint/shared';

/**
 * 바뀐 정보 알림 뒤 재검수의 판정 차이 (FR-RU-061).
 *
 * 변경이 감지되면 전 규칙을 다시 판정한다. 그 결과로 **바뀐 곳의 판정이** 새로 생겼는지 · 사라졌는지 ·
 * 등급이 바뀌었는지를 알림 카드가 변경 내용과 함께 말한다. 견주는 둘은 알림 **직전** 검수와 알림 **뒤 첫**
 * 검수다 — 변경 내용(`changes`)을 가르는 기준과 같다. 그 뒤 사람이 일정을 고쳐 다시 검수한 것까지 섞으면
 * 변경의 영향이 아니게 된다.
 *
 * 바뀐 곳을 대상으로 한 판정만 본다(두 곳을 잇는 판정은 한쪽이 그곳이면 든다). 순수 함수다.
 */
export interface VerdictLine {
  readonly ruleCode: string;
  readonly severity: Severity;
  readonly targetItemId: number | null;
  readonly targetItemId2: number | null;
}

export interface VerdictDiff {
  readonly added: readonly { readonly ruleCode: string; readonly severity: Severity }[];
  readonly removed: readonly { readonly ruleCode: string; readonly severity: Severity }[];
  readonly changed: readonly { readonly ruleCode: string; readonly from: Severity; readonly to: Severity }[];
}

const RANK: Readonly<Record<Severity, number>> = { BLOCKER: 4, ERROR: 3, WARNING: 2, UNVERIFIED: 1 };

/** 같은 규칙 · 같은 대상이면 한 판정이다. 한 규칙이 한 곳에 둘을 냈으면 무거운 쪽으로 본다 */
function byKey(lines: readonly VerdictLine[], itemIds: ReadonlySet<number>): Map<string, VerdictLine> {
  const out = new Map<string, VerdictLine>();
  for (const line of lines) {
    const touches = (line.targetItemId !== null && itemIds.has(line.targetItemId))
      || (line.targetItemId2 !== null && itemIds.has(line.targetItemId2));
    if (!touches) continue;
    const pair = [line.targetItemId ?? 0, line.targetItemId2 ?? 0].sort((a, b) => a - b);
    const key = `${line.ruleCode}:${String(pair[0])}:${String(pair[1])}`;
    const seen = out.get(key);
    if (seen === undefined || RANK[line.severity] > RANK[seen.severity]) out.set(key, line);
  }
  return out;
}

export function verdictDiff(
  before: readonly VerdictLine[],
  after: readonly VerdictLine[],
  itemIds: ReadonlySet<number>,
): VerdictDiff {
  const b = byKey(before, itemIds);
  const a = byKey(after, itemIds);
  const order = (x: { ruleCode: string }, y: { ruleCode: string }): number => x.ruleCode.localeCompare(y.ruleCode);
  const added = [...a.entries()].filter(([k]) => !b.has(k)).map(([, v]) => ({ ruleCode: v.ruleCode, severity: v.severity }));
  const removed = [...b.entries()].filter(([k]) => !a.has(k)).map(([, v]) => ({ ruleCode: v.ruleCode, severity: v.severity }));
  const changed = [...a.entries()]
    .flatMap(([k, v]) => {
      const was = b.get(k);
      return was !== undefined && was.severity !== v.severity ? [{ ruleCode: v.ruleCode, from: was.severity, to: v.severity }] : [];
    });
  return { added: added.sort(order), removed: removed.sort(order), changed: changed.sort(order) };
}
