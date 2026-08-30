import { describe, expect, it } from 'vitest';
import { MatchCondition } from '../batch/impact-finder';
import { isDismissable, notificationCopy } from './notification-copy';

const ALL: MatchCondition[] = [1, 2, 3, 4, 5, 6];

describe('알림 문구', () => {
  it('조건 6종 모두 무엇 · 영향 · 조치 셋을 채운다 (FR-MO-033)', () => {
    for (const c of ALL) {
      const copy = notificationCopy(c, false);
      expect(copy.what, `조건 ${c}`).not.toBe('');
      expect(copy.impact, `조건 ${c}`).not.toBe('');
      expect(copy.action, `조건 ${c}`).not.toBe('');
    }
  });

  it('조건마다 다른 문구다 — 같으면 조건을 구분할 이유가 없다', () => {
    const whats = new Set(ALL.map((c) => notificationCopy(c, false).what));
    expect(whats.size).toBe(ALL.length);
  });

  it('🔴 비표출이면 조건과 무관하게 표출 중단 문구가 이긴다 (PM-NG-009)', () => {
    for (const c of ALL) {
      expect(notificationCopy(c, true).what, `조건 ${c}`).toContain('표출이 중단');
    }
  });

  it('🔴 비표출 알림은 무시할 수 없다 (FR-MO-037 · PM-NG-010)', () => {
    expect(isDismissable(true)).toBe(false);
    expect(isDismissable(false)).toBe(true);
  });

  it('🔴 문구에 거리 · 이동시간을 적지 않는다 — 판정이 아니라 거르기다 (FR-MO-052)', () => {
    /*
     * 조건 6 이 직선 우회거리 5km 로 후보를 거르지만 그건 「볼 만한가」를 가리는 값이지
     * 이동시간 판정이 아니다. 알림에 거리를 적으면 사용자가 그것을 판정으로 읽는다.
     */
    const text = ALL.flatMap((c) => Object.values(notificationCopy(c, false))).join(' ');
    expect(text).not.toMatch(/\d+\s*(km|미터|m\b|분|시간)/);
  });

  it('🔴 신호 강도 같은 점수를 말하지 않는다 (FR-RU-121)', () => {
    const text = ALL.flatMap((c) => Object.values(notificationCopy(c, false))).join(' ');
    expect(text).not.toMatch(/점수|강도|\d+점/);
  });

  it('판매량 · 흥행을 말하지 않는다 (FR-MO-055)', () => {
    const text = ALL.flatMap((c) => Object.values(notificationCopy(c, false))).join(' ');
    expect(text).not.toMatch(/판매|흥행|인기|매출|트렌드/);
  });
});
