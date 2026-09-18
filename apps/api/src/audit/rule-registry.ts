import { R01OperatingRule } from '../engine/rules/r01-operating';
import { R02EventPeriodRule } from '../engine/rules/r02-event';
import { R03TimeOverlapRule } from '../engine/rules/r03-overlap';
import { R04ImbalanceRule } from '../engine/rules/r04-imbalance';
import { R05UnverifiableRule } from '../engine/rules/r05-unverifiable';
import { R06ChangeRule } from '../engine/rules/r06-change';
import { R07MealRestRule } from '../engine/rules/r07-meal-rest';
import { R08TravelTimeRule } from '../engine/rules/r08-travel';
import { R09RainRiskRule } from '../engine/rules/r09-rain';
import { R10TargetFitRule } from '../engine/rules/r10-target';
import { RULE_CONSTANTS, SETTING_DEFAULTS, type RuleDataSource } from '@tourlint/shared';
import type { AuditRule, Finding, ItineraryContext } from '../engine/rules/types';

/**
 * 규칙 목록 (API 설계 §2 · NF-MT-002).
 *
 * 규칙을 추가할 때 **기존 규칙 코드를 고치지 않는다.** 여기 한 줄만 늘어난다.
 * 규칙끼리 서로 참조하지 않으므로 순서도 결과에 영향을 주지 않는다.
 *
 * 열 개가 다 찼다. 규칙을 더 넣을 때도 여기 한 줄만 늘어난다.
 */
export const RULES: readonly AuditRule[] = [
  new R01OperatingRule(),
  new R02EventPeriodRule(),
  new R03TimeOverlapRule(),
  new R04ImbalanceRule(),
  new R05UnverifiableRule(),
  new R06ChangeRule(),
  new R07MealRestRule(),
  new R08TravelTimeRule(),
  new R09RainRiskRule(),
  new R10TargetFitRule(),
];

/**
 * 이 목록으로 낸 판정임을 기록에 남긴다. 규칙이 늘거나 버전이 오르면 함께 오른다.
 *
 * `1.0.0` 여덟 규칙 → `1.1.0` R09 우천 → `1.2.0` R10 타깃 적합성 → `1.2.1` R06 비표출 메시지 → `1.2.2` R01 조건부 휴무 문구
 * → `1.2.3` R07 회사 기준 병기 문장 · R10 표준 프로파일.
 * R09 를 넣을 때 올리는 것을 빠뜨려 함께 올렸다 — 같은 버전으로 기록된 실행이
 * 실제로는 규칙 수가 다르면 나중에 결과를 되짚을 수 없다 (FR-AU-042).
 *
 * 규칙 수가 그대로여도 **판정 문구가 달라지면 올린다.** 저장된 finding 은 message 를
 * 그대로 들고 있어서, 같은 버전에 두 문구가 섞이면 어느 쪽인지 가릴 수 없다.
 */
export const RULESET_VERSION = '1.2.4';

export interface RuleExplanation {
  /** 쓰는 데이터. 화면은 코드 대신 관광정보 · 일정 · 이동 시간 · 날씨 예보로 적는다 */
  readonly dataSources: readonly RuleDataSource[];
  /** 기준값. 표준 값에서 만든다 — 숫자를 여기 따로 적으면 상수와 어긋난다 */
  readonly threshold: string;
  /** 규칙이 실제로 내는 문장 모양의 예시 */
  readonly example: string;
  /** 회사 기준으로 조정할 수 있는가. R07 만 그렇다 (FR-OP-022) */
  readonly companyAdjustable: boolean;
}

const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`;

/**
 * 검수 기준 탭의 규칙 설명 (FR-OP-025 · UI-S8-005 · API 5-10).
 *
 * 규칙 클래스가 아니라 여기 둔다 — 설명은 판정에 쓰이지 않고, 규칙 파일은 판정만 담는다.
 * 규칙이 늘면 `RULES` 와 이 표에 한 줄씩 는다(spec 이 둘의 코드 목록이 같은지 본다).
 */
export const RULE_EXPLANATIONS: Readonly<Record<string, RuleExplanation>> = {
  R01: {
    dataSources: ['KTO'],
    threshold: '관광정보의 휴무일 · 운영시간 · 입장 마감 시각',
    example: '경포대 — 10/26(월) 매주 월요일 휴무',
    companyAdjustable: false,
  },
  R02: {
    dataSources: ['KTO'],
    threshold: '관광정보의 행사 시작일 · 종료일',
    example: '강릉 커피축제 — 행사가 2026-10-12 에 끝났습니다 (방문 2026-10-23)',
    companyAdjustable: false,
  },
  R03: {
    dataSources: ['ITINERARY'],
    threshold: `같은 일차에서 ${RULE_CONSTANTS.R03_MIN_OVERLAP_MINUTES}분이라도 겹치면`,
    example: '오죽헌(10:00~11:30) 와 선교장(11:00~12:00) 가 30분 겹칩니다',
    companyAdjustable: false,
  },
  R04: {
    dataSources: ['KTO'],
    threshold: `같은 유형 ${SETTING_DEFAULTS.r04Threshold}곳 이상`,
    example:
      `1일차에 같은 관광 유형(12)이 4곳입니다. 기준 ${SETTING_DEFAULTS.r04Threshold}곳 이상이라 일정이 한쪽으로 쏠려 있습니다. ` +
      '한 곳을 다른 유형으로 바꿔 보세요.',
    companyAdjustable: false,
  },
  R05: {
    dataSources: ['KTO'],
    threshold: '어느 관광지인지 정해지지 않았거나 판정에 필요한 정보가 없을 때',
    example: '초당순두부 — 어느 관광지인지 확정되지 않아 검수하지 못했습니다.',
    companyAdjustable: false,
  },
  R06: {
    dataSources: ['KTO'],
    threshold: '지난 검수 뒤 관광정보가 바뀌었거나 비표출로 바뀌었을 때',
    example:
      '공사 데이터에서 비표출로 전환된 관광지입니다. 사유는 알 수 없으며 그대로 둘 수 없습니다. ' +
      '반경 20km 안 같은 유형 관광지로 교체하거나 일정에서 빼 주세요.',
    companyAdjustable: false,
  },
  R07: {
    dataSources: ['ITINERARY'],
    threshold: `연속 ${SETTING_DEFAULTS.r07SpanHours}시간 · 식사 ${SETTING_DEFAULTS.r07MealMinutes}분`,
    example:
      `1일차 09:00~18:00 연속 9시간 중 식사(점심)가 45분으로 최소 ${SETTING_DEFAULTS.r07MealMinutes}분보다 짧습니다. ` +
      '시간을 늘리거나 뒤 일정을 미뤄 주세요.',
    companyAdjustable: true,
  },
  R08: {
    dataSources: ['KTO', 'KAKAO'],
    threshold: `이동에 걸리는 시간이 배정 시간보다 길면(여유 ${RULE_CONSTANTS.R08_TRAVEL_BUFFER_MINUTES}분)`,
    example: '오죽헌 → 경포대 이동에 약 25분이 걸리는데 배정된 시간은 15분입니다. 10분이 모자랍니다.',
    companyAdjustable: false,
  },
  R09: {
    dataSources: ['KTO', 'KMA'],
    threshold:
      `야외 비중 ${percent(RULE_CONSTANTS.R09_OUTDOOR_RATIO_THRESHOLD)} 이상 · ` +
      `강수확률 ${percent(RULE_CONSTANTS.R09_FORECAST_RAIN_THRESHOLD)}(예보) 또는 ${percent(RULE_CONSTANTS.R09_CLIMATE_RAIN_THRESHOLD)}(평년) 이상`,
    example: '2026-10-23 일정은 야외 비중이 75%입니다. 단기예보 기준 — 강수확률 70%. 우천 시 정상 운영이 어렵습니다.',
    companyAdjustable: false,
  },
  R10: {
    dataSources: ['KTO'],
    threshold: `타깃 · 콘셉트별 표준 프로파일(자주 넣는 종류 · ${RULE_CONSTANTS.R10_NIGHT_SLOT_FROM} 이후 일정)`,
    example: '커플 · 감성 상품인데 카페/ 찻집, 19:00 이후 일정이(가) 일정에 없습니다.',
    companyAdjustable: false,
  },
};

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
