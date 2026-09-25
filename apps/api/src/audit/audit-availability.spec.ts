import { describe, expect, it } from 'vitest';
import { AUDIT_BUDGET_MESSAGE, nextKstMidnight, toAvailability } from './audit.service';

// 예산이 다 되면 검수 버튼을 미리 막고 재개 시점을 적는다 (UI-ST-007 · EX-QT-002 · #838)
const closed = { allowed: false, ratio: 1, reasonCode: 'BUDGET_EXHAUSTED' as const, warn: true, remaining: 0 };
const open = { allowed: true, ratio: 0.3, reasonCode: null, warn: false, remaining: 5600 };

describe('검수 가능 여부', () => {
  it('🔴 다 썼으면 막고 한국 시간 다음 날 0시를 재개 시점으로 준다', () => {
    // 10-12 23:59 KST — 아직 12일이다
    expect(toAvailability(closed, new Date('2026-10-12T14:59:00Z'))).toEqual({
      available: false, reasonCode: 'BUDGET_EXHAUSTED', resumesAt: '2026-10-13T00:00:00+09:00',
    });
    // 10-13 00:30 KST — 이미 13일이라 14일에 열린다
    expect(nextKstMidnight(new Date('2026-10-12T15:30:00Z'))).toBe('2026-10-14T00:00:00+09:00');
    // 달이 바뀐다
    expect(nextKstMidnight(new Date('2026-09-30T10:00:00Z'))).toBe('2026-10-01T00:00:00+09:00');
  });

  it('남았으면 열려 있고 재개 시점이 없다 — 숫자는 주지 않는다', () => {
    const answer = toAvailability(open, new Date('2026-10-12T01:00:00Z'));
    expect(answer).toEqual({ available: true, reasonCode: null, resumesAt: null });
    expect(Object.keys(answer)).not.toContain('remaining');
  });

  it('🔴 막혔을 때의 안내는 다시 열리는 때와 지금 할 수 있는 일을 적는다 — 관리자 · 예산 상향 같은 말은 없다', () => {
    expect(AUDIT_BUDGET_MESSAGE).toContain('내일 0시부터 다시 검수할 수 있고');
    expect(AUDIT_BUDGET_MESSAGE).toContain('일정 편집과 지난 결과 보기는 지금도');
    expect(AUDIT_BUDGET_MESSAGE).not.toMatch(/관리자|예산 상향|공사 데이터/);
  });
});
