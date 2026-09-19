import { describe, expect, it } from 'vitest';
import { findingMessage } from './finding-message';

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
