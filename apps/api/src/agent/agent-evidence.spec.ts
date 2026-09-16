import { describe, expect, it } from 'vitest';
import { AgentEvidence } from './agent-evidence';

describe('AgentEvidence — 도구 결과에 없던 값은 버린다 (FR-AG-003 · EI-LM-008 · EX-AG-003)', () => {
  it('🔴 도구 결과에 없던 contentid 를 섞은 출력에서 그 항목만 빠진다', () => {
    const evidence = new AgentEvidence();
    evidence.add('contentId', '129784');
    evidence.add('contentId', 125790);

    const { kept, dropped } = evidence.keep(
      [{ itemId: 1, contentId: '129784' }, { itemId: 2, contentId: '999999' }, { itemId: 3, contentId: 125790 }],
      (s) => [['contentId', s.contentId]],
    );
    expect(kept.map((s) => s.itemId)).toEqual([1, 3]);
    expect(dropped).toBe(1);
  });

  it('🔴 항목의 값이 여럿이면 하나라도 없으면 버린다 — finding id 와 상품 id', () => {
    const evidence = new AgentEvidence();
    evidence.add('findingId', 301);
    evidence.add('productId', 9);
    const { kept } = evidence.keep(
      [{ findingIds: [301], productId: 9 }, { findingIds: [301, 302], productId: 9 }],
      (p) => [...p.findingIds.map((id) => ['findingId', id] as const), ['productId', p.productId] as const],
    );
    expect(kept).toHaveLength(1);
  });

  it('종류가 다르면 같은 값이어도 없는 것이다 — 상품 id 를 알림 id 로 쓰지 못한다', () => {
    const evidence = new AgentEvidence();
    evidence.add('productId', 9);
    expect(evidence.has('notificationId', 9)).toBe(false);
  });

  it('비었거나 모양이 아닌 값은 적지도 통과시키지도 않는다', () => {
    const evidence = new AgentEvidence();
    evidence.add('contentId', '');
    evidence.add('contentId', null);
    expect(evidence.has('contentId', '')).toBe(false);
    expect(evidence.has('contentId', undefined)).toBe(false);
    expect(evidence.has('contentId', { id: '1' })).toBe(false);
  });

  describe('전화번호는 항목을 버리지 않고 null 로 바꾼다 (EX-AG-005)', () => {
    it('🔴 도구 결과에 있던 번호면 모델이 쓴 모양 그대로, 없던 번호면 null', () => {
      const evidence = new AgentEvidence();
      evidence.addPhonesFrom('033-640-4471 (강릉시청 관광과)');
      expect(evidence.phoneOrNull('033 640 4471')).toBe('033 640 4471');
      expect(evidence.phoneOrNull('033-640-4472')).toBeNull();
      expect(evidence.phoneOrNull(null)).toBeNull();
    });

    it('문장 속 번호를 여럿 읽는다 — 대표번호 · 휴대전화 포함', () => {
      const evidence = new AgentEvidence();
      evidence.addPhonesFrom('문의 1588-1234 / 담당 010-1234-5678, (02)123-4567');
      expect(evidence.has('phone', '15881234')).toBe(true);
      expect(evidence.has('phone', '01012345678')).toBe(true);
      expect(evidence.has('phone', '021234567')).toBe(true);
    });

    it('짧은 숫자는 전화번호로 치지 않는다 — 우연히 맞는 번호를 막는다', () => {
      const evidence = new AgentEvidence();
      evidence.add('phone', '1234');
      expect(evidence.phoneOrNull('1234')).toBeNull();
    });
  });
});
