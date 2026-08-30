import type { MatchCondition, NotificationKind } from '../batch/impact-finder';

/**
 * 알림 문구 (FR-MO-033).
 *
 * FR-MO-033 은 알림에 **대상 상품명 · 출발일 · 무엇이 어떻게 바뀌었는지 · 그로 인한 영향 ·
 * 권장 조치** 다섯 가지를 요구한다. 앞의 셋은 저장된 값에서 나오고, 뒤의 둘은 여기서 만든다.
 *
 * ## 왜 저장하지 않고 만드는가
 *
 * `notification.body` 에는 `condition` · `contentTypeId` · `modifiedTime` · `hidden` 만 있다.
 * 문구를 저장하면 문구를 고칠 때 이미 쌓인 알림이 옛 문구로 남고, 관광지명을 담으면
 * 공사 원문이 알림 테이블에 들어간다 (FR-MO-002 · DB 명세서 6-4).
 *
 * 조건 번호가 곧 분류이자 문구다. 순수 함수라 조건별 문구를 테스트로 고정할 수 있다.
 *
 * ## 지어내지 않는 것
 *
 * 거리 · 이동시간을 적지 않는다. 조건 6 이 직선 우회거리로 거르지만 그건 「볼 만한가」를
 * 가리는 값이지 판정이 아니다 — 실제 이동시간은 제안 단계에서 R08 이 다시 본다
 * (`opportunity.ts` 주석 · FR-MO-052).
 */

export interface NotificationCopy {
  /** 무엇이 어떻게 바뀌었는가 */
  readonly what: string;
  /** 그로 인한 영향 */
  readonly impact: string;
  /** 권장 조치 */
  readonly action: string;
}

const RISK: Readonly<Record<1 | 2 | 3, NotificationCopy>> = {
  1: {
    what: '일정에 포함된 관광지의 운영정보가 바뀌었습니다.',
    impact: '휴무일 · 운영시간이 달라졌다면 기존 검수 결과가 더 이상 맞지 않습니다.',
    action: '다시 검수해 판정을 갱신하세요.',
  },
  2: {
    what: '같은 시군구의 관광지 정보가 바뀌었습니다.',
    impact: '출발일이 가까워 주변 정보가 달라졌을 수 있습니다. 일정에 든 곳은 아닙니다.',
    action: '변경 내역을 확인하고 필요하면 다시 검수하세요.',
  },
  3: {
    what: '여행일과 겹치는 행사 정보가 바뀌었습니다.',
    impact: '행사 기간이나 운영시간이 달라졌다면 그날 일정에 영향이 갑니다.',
    action: '행사 정보를 확인하고 필요하면 다시 검수하세요.',
  },
};

const OPPORTUNITY: Readonly<Record<4 | 5 | 6, NotificationCopy>> = {
  4: {
    what: '이 상품에 없는 유형의 관광지가 새로 등록됐습니다.',
    impact: '타깃 적합성에서 비어 있다고 본 유형을 채울 수 있습니다.',
    action: '반영할지 검토하세요. 넣으면 이동시간을 다시 검수합니다.',
  },
  5: {
    what: '일정의 빈 시간대에 넣을 만한 관광지가 새로 등록됐습니다.',
    impact: '비어 있던 구간을 채울 수 있습니다.',
    action: '반영할지 검토하세요. 넣으면 이동시간을 다시 검수합니다.',
  },
  6: {
    what: '동선에서 크게 벗어나지 않는 곳에 관광지가 새로 등록됐습니다.',
    impact: '기존 일정을 크게 바꾸지 않고 넣을 수 있습니다.',
    action: '반영할지 검토하세요. 넣으면 이동시간을 다시 검수합니다.',
  },
};

/** 비표출 전환은 조건과 무관하게 이 문구가 이긴다 — 차단 사유이고 무시할 수 없다 */
const HIDDEN: NotificationCopy = {
  what: '공사에서 이 관광지의 표출이 중단됐습니다.',
  impact: '출시 불가 사유입니다. 정보를 확인할 수 없어 판정할 수 없습니다.',
  action: '다른 관광지로 대체하거나 일정에서 빼세요.',
};

/**
 * 조건과 비표출 여부로 문구를 고른다.
 *
 * 비표출이면 조건을 덮어쓴다. 조건 1 로 잡혔더라도 사용자가 알아야 할 것은 "운영정보가
 * 바뀌었다" 가 아니라 "표출이 중단됐다" 이기 때문이다.
 */
export function notificationCopy(condition: MatchCondition, hidden: boolean): NotificationCopy {
  if (hidden) return HIDDEN;
  return condition <= 3
    ? RISK[condition as 1 | 2 | 3]
    : OPPORTUNITY[condition as 4 | 5 | 6];
}

/**
 * 무시할 수 있는가 (FR-MO-037 · PM-NG-010).
 *
 * **비표출 전환 알림은 무시할 수 없다.** 차단 등급을 무시할 수 없는 것과 같은 이유다 —
 * 사용자가 지워 버리면 출시 불가 사유가 화면에서 사라진다.
 */
export function isDismissable(hidden: boolean): boolean {
  return !hidden;
}

/** 조건 번호 → 분류. `kindOf` 와 같은 규칙이지만 저장된 kind 를 신뢰한다 */
export function kindLabel(kind: NotificationKind): string {
  return kind === 'RISK' ? '위험' : '기회';
}
