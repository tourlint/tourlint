import { describe, expect, it } from 'vitest';
import { kstIso } from './kst';

/**
 * 화면과 PDF 는 받은 문자열을 그대로 잘라 쓴다. UTC 로 내보내면 9시간 이르게 보인다 —
 * 오전에 돌린 검수가 새벽으로 찍혔다 (2026-09-11 감사 치명 3번 · TM-015).
 */
describe('KST ISO 표기 (TM-015 · API 설계 3-2)', () => {
  it('🔴 UTC 가 아니라 +09:00 으로 적는다', () => {
    expect(kstIso(new Date('2026-09-20T01:00:00.000Z'))).toBe('2026-09-20T10:00:00+09:00');
  });

  it('🔴 자정을 넘으면 날짜도 함께 넘어간다', () => {
    expect(kstIso(new Date('2026-09-19T16:30:00.000Z'))).toBe('2026-09-20T01:30:00+09:00');
  });

  it('가리키는 시각은 그대로다 — 다시 읽으면 같은 값이다', () => {
    const at = new Date('2026-09-20T01:00:00.000Z');
    expect(new Date(kstIso(at)).getTime()).toBe(at.getTime());
  });
});
