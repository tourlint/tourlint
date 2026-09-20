import { describe, expect, it } from 'vitest';
import { findingMessage, withPlaceName } from './finding-message';

describe('검수 표시 문구', () => {
  it('저장된 분류 코드 대신 실제 장소와 기준을 표시한다', () => {
    const evidence = { axis: 'lclsSystm3', key: 'NA020900', count: 4, threshold: 3, scope: 'PRODUCT', itemIds: [1, 2, 3, 4] };
    const message = findingMessage('R04', '소분류(NA020900)이 4곳입니다', evidence, new Map([[1, '경포해변'], [2, '안목해변'], [3, '정동진해변'], [4, '주문진해변']]));
    expect(message).toContain('경포해변, 안목해변, 정동진해변 등');
    expect(message).toContain('4곳'); expect(message).toContain('3곳 이상');
    expect(message).not.toMatch(/NA020900|소분류/);
    expect(evidence.key).toBe('NA020900');
  });
  it('알 수 없는 분류와 삭제된 장소의 이름을 지어내지 않는다', () => {
    expect(findingMessage('R04', 'X999', { count: 3, threshold: 3, key: 'X999', scope: 'DAY', dayNo: 2 })).toContain('2일차에 비슷한 종류');
    expect(findingMessage('R04', '12', { count: 3, threshold: 3, key: '12', axis: 'contentTypeId' })).toContain('관광지 방문');
  });
  it('소수 시간 대신 시·분으로 표시하고 공백을 연속 활동이라고 말하지 않는다', () => {
    expect(findingMessage('R07', '1일차 10:00~16:04 연속 6.1시간 일정에 식사·휴식 항목이 없습니다. 공백 구간에 식사를 넣어 주세요.', { span: { minutes: 364 } })).toContain('전체 6시간 4분');
  });
  it('구성 부족은 이름으로 설명하고 알 수 없는 코드는 노출하지 않는다', () => {
    const message = findingMessage('R10', '가족(아이 동반) · 자연경관 상품인데 NA01이(가) 일정에 없습니다.', { missingLcls2: ['NA03', 'UNKNOWN'] });
    expect(message).toContain('자연생태'); expect(message).not.toMatch(/NA01|UNKNOWN|이\(가\)/);
  });
  it('다른 판정의 의미와 원문은 바꾸지 않는다', () => {
    expect(findingMessage('R03', '30분 겹칩니다.', {})).toBe('30분 겹칩니다.');
  });
});

/**
 * 장소 담기 · 수정안 삽입으로 들어온 항목은 이름을 저장하지 않는다 (DR-PR-001). 저장된 문장의
 * 빈 앞자리를 표시할 때 채운다 — 화면에 「 — 휴무일 정보를 확인할 수 없습니다」 가 떴다 (#606).
 */
describe('장소 이름은 표시할 때 채운다 (#606)', () => {
  it('🔴 이름 없이 저장된 문장에 조회한 이름을 붙인다', () => {
    expect(withPlaceName('휴무일 정보를 확인할 수 없습니다', '리고엠')).toBe('리고엠 — 휴무일 정보를 확인할 수 없습니다');
    // 고치기 전에 저장된 결과들 — 빈 이름이 대시와 "null" 을 남겼다
    expect(withPlaceName(' — 휴무일 정보를 확인할 수 없습니다', '리고엠')).toBe('리고엠 — 휴무일 정보를 확인할 수 없습니다');
    expect(withPlaceName('null — 휴무일 정보를 확인할 수 없습니다', '리고엠')).toBe('리고엠 — 휴무일 정보를 확인할 수 없습니다');
  });

  it('🔴 이름을 못 얻으면 앞자리를 비워 두지 않고 본문만 보여 준다', () => {
    expect(withPlaceName(' — 휴무일 정보를 확인할 수 없습니다', null)).toBe('휴무일 정보를 확인할 수 없습니다');
    expect(withPlaceName('휴무일 정보를 확인할 수 없습니다', '  ')).toBe('휴무일 정보를 확인할 수 없습니다');
  });

  it('이미 이름이 붙은 문장은 그대로 둔다 — 두 번 붙이지 않는다', () => {
    expect(withPlaceName('경포대 — 방문 12:00 이 휴게시간에 걸칩니다', '경포대'))
      .toBe('경포대 — 방문 12:00 이 휴게시간에 걸칩니다');
  });

  it('이름을 쓰지 않는 규칙의 문장은 건드리지 않는다', () => {
    // R07 · R10 은 상품 전체를 말한다. 대상 이름을 넘겨도 앞에 붙지 않는다
    expect(findingMessage('R07', '1일차 연속 6시간 일정에 식사·휴식 항목이 없습니다.', {}, new Map(), '경포대'))
      .not.toContain('경포대 —');
    // R01 은 붙인다
    expect(findingMessage('R01', '휴무일 정보를 확인할 수 없습니다', {}, new Map(), '리고엠'))
      .toBe('리고엠 — 휴무일 정보를 확인할 수 없습니다');
  });
});
