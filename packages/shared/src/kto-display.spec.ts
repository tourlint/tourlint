import { describe, expect, it } from 'vitest';
import { ktoRawText, unavailableKind, unavailableText } from './kto-display';

describe('공사 원문 표기 (UI-S3-012)', () => {
  it('🔴 실측 원문의 <br> 은 줄바꿈으로 — 동부시장 · 감자적본부', () => {
    expect(ktoRawText('06:00~23:00<br>※ 점포별 상이함')).toBe('06:00~23:00\n※ 점포별 상이함');
    expect(ktoRawText('- 10:00~20:30<br>- 준비시간 14:30~15:00<br/>- 마지막 주문 19:45<BR />'))
      .toBe('- 10:00~20:30\n- 준비시간 14:30~15:00\n- 마지막 주문 19:45\n');
  });

  it('br 말고는 되돌리지 않고 나머지 글자는 그대로 둔다', () => {
    expect(ktoRawText('<b>매주</b> 월요일 <script>x</script>')).toBe('<b>매주</b> 월요일 <script>x</script>');
    expect(ktoRawText('09:00~18:00 (입장 마감 17:00)')).toBe('09:00~18:00 (입장 마감 17:00)');
  });
});

describe('원문을 못 읽은 까닭 (UI-ST-005 · FR-CM-012)', () => {
  it('🔴 조회 실패와 정보 없음 두 갈래로 적고 사유코드를 싣지 않는다', () => {
    expect(unavailableKind('CONTENT_NOT_FOUND')).toBe('NO_DATA');
    for (const code of ['KTO_FETCH_FAILED', 'KTO_QUOTA_EXCEEDED', 'KTO_AUTH_ERROR']) {
      expect(unavailableKind(code)).toBe('FETCH_FAILED');
      expect(unavailableText(code)).toMatch(/^조회 실패 — /);
      expect(unavailableText(code)).not.toContain(code);
    }
    expect(unavailableText('CONTENT_NOT_FOUND')).toMatch(/^정보 없음 — /);
    expect(unavailableText('CONTENT_NOT_FOUND')).not.toContain('CONTENT_NOT_FOUND');
  });
});
