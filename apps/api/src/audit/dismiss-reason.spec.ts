import { describe, expect, it } from 'vitest';
import { readReason } from './audit.controller';
import { DomainException } from '../common/domain.exception';

// 무시 사유는 반드시 있어야 한다 (FR-AU-068). 되돌리기 가드: readReason 이 빈 사유를 통과시키면
// 이 스펙이 빨개진다.
describe('readReason — 무시 사유 필수', () => {
  it('사유가 없으면 400 DISMISS_REASON_REQUIRED 로 막는다', () => {
    expect(() => readReason({})).toThrow(DomainException);
    try {
      readReason({});
    } catch (e) {
      expect((e as DomainException).reasonCode).toBe('DISMISS_REASON_REQUIRED');
    }
  });

  it('빈 문자열 · 공백만도 막는다', () => {
    expect(() => readReason({ reason: '' })).toThrow(DomainException);
    expect(() => readReason({ reason: '   ' })).toThrow(DomainException);
    expect(() => readReason(null)).toThrow(DomainException);
  });

  it('사유가 있으면 양끝 공백을 떼고 돌려준다', () => {
    expect(readReason({ reason: '  고객 요청 사항  ' })).toBe('고객 요청 사항');
  });

  it('200자를 넘기면 같은 코드로 막는다', () => {
    expect(() => readReason({ reason: 'ㄱ'.repeat(201) })).toThrow(DomainException);
    expect(readReason({ reason: 'ㄱ'.repeat(200) })).toHaveLength(200);
  });
});
