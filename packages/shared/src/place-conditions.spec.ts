import { describe, expect, it } from 'vitest';
import { ACCESSIBLE_FIELD_LABEL, PET_FIELD_LABEL, conditionRows } from './place-conditions';

describe('장소 「자세히」 조건 이름표 (UI-S2-040 · #850)', () => {
  it('비어 있지 않은 항목만 표의 순서대로 옮긴다', () => {
    // fixtures/kto/23_detailWithTour2_129784.json (오죽헌) 의 일부
    const rows = conditionRows({
      contentid: '129784', restroom: '장애인 화장실 있음', wheelchair: '대여 가능(5대)', elevator: '',
      braileblock: '', lactationroom: '수유실 있음',
    }, ACCESSIBLE_FIELD_LABEL);
    expect(rows).toEqual([
      { label: '휠체어', value: '대여 가능(5대)' },
      { label: '화장실', value: '장애인 화장실 있음' },
      { label: '수유실', value: '수유실 있음' },
    ]);
  });

  it('🔴 모르는 필드는 싣지 않는다 — 영어 이름이 화면에 나가면 내부 코드다 (UI-CM-040)', () => {
    expect(conditionRows({ contentid: '1', somethingNew: '값' }, PET_FIELD_LABEL)).toEqual([]);
  });

  it('반려동물 상세도 같은 방식이다', () => {
    // fixtures/kto/21_detailPetTour2_2628994.json 의 일부
    expect(conditionRows({ acmpyNeedMtr: '목줄 착용', acmpyTypeCd: '전구역 동반가능' }, PET_FIELD_LABEL)).toEqual([
      { label: '동반 구분', value: '전구역 동반가능' },
      { label: '동반 시 필요 사항', value: '목줄 착용' },
    ]);
  });

  it('없으면 빈 목록이다', () => {
    expect(conditionRows(null, ACCESSIBLE_FIELD_LABEL)).toEqual([]);
    expect(conditionRows(undefined, PET_FIELD_LABEL)).toEqual([]);
  });
});
