import { R01OperatingRule } from '../engine/rules/r01-operating';
import { R02EventPeriodRule } from '../engine/rules/r02-event';
import { R03TimeOverlapRule } from '../engine/rules/r03-overlap';
import { R04ImbalanceRule } from '../engine/rules/r04-imbalance';
import { R06ChangeRule } from '../engine/rules/r06-change';
import { R07MealRestRule } from '../engine/rules/r07-meal-rest';
import type { AuditRule, Finding, ItineraryContext } from '../engine/rules/types';

/**
 * 규칙 목록 (API 설계 §2 · NF-MT-002).
 *
 * 규칙을 추가할 때 **기존 규칙 코드를 고치지 않는다.** 여기 한 줄만 늘어난다.
 * 규칙끼리 서로 참조하지 않으므로 순서도 결과에 영향을 주지 않는다.
 *
 * 지금은 여섯이다 — R05 · R08 은 W2, R09 · R10 은 W3.
 */
export const RULES: readonly AuditRule[] = [
  new R01OperatingRule(),
  new R02EventPeriodRule(),
  new R03TimeOverlapRule(),
  new R04ImbalanceRule(),
  new R06ChangeRule(),
  new R07MealRestRule(),
];

/** 이 목록으로 낸 판정임을 기록에 남긴다. 규칙이 늘거나 버전이 오르면 함께 오른다 */
export const RULESET_VERSION = '1.0.0';

/**
 * 전 규칙을 완주한다.
 *
 * **차단이 나와도 멈추지 않는다** (API 설계 6-1). 첫 차단에서 끊으면 사용자가 고칠 때마다
 * 새 문제가 하나씩 튀어나와 몇 번을 다시 검수해야 하는지 알 수 없다.
 *
 * 규칙 하나가 던져도 나머지는 계속한다 — 규칙 단위 격리 (EX-CM-001 `RULE`).
 */
export function evaluateAll(
  ctx: ItineraryContext,
  rules: readonly AuditRule[] = RULES,
): { readonly findings: readonly Finding[]; readonly failedRules: readonly string[] } {
  const findings: Finding[] = [];
  const failedRules: string[] = [];

  for (const rule of rules) {
    try {
      findings.push(...rule.evaluate(ctx));
    } catch {
      // 규칙 하나가 깨져도 검수 전체를 버리지 않는다. 무엇이 깨졌는지는 남긴다
      failedRules.push(rule.code);
    }
  }
  return { findings, failedRules };
}
