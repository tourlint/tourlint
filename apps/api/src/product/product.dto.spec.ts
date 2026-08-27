import { describe, expect, it } from 'vitest';
import { validateCreate, validateUpdate, type CreateProductDto } from './product.dto';

/**
 * 상품 등록 검증 — 순수 함수라 DB 없이 돈다. 서버가 저장 전에 다시 보는 가드다 (EX-IN-005).
 * 클라이언트 검증만으로는 API 직접 호출을 막지 못한다.
 */

function base(overrides: Partial<CreateProductDto> = {}): CreateProductDto {
  return {
    name: '강릉 2박 3일',
    ldongRegnCd: '51',
    ldongSignguCd: '150',
    startDate: '2026-10-22',
    nights: 2,
    transport: 'CAR',
    headCount: 20,
    days: [
      { day: 1, items: [{ start: '10:00', end: '11:30', place: '경포대', itemType: 'SIGHT' }] },
      { day: 2, items: [{ start: '09:00', end: '', place: '오죽헌', itemType: 'SIGHT' }] },
      { day: 3, items: [{ start: '12:00', end: '13:00', place: '초당순두부', itemType: 'MEAL' }] },
    ],
    ...overrides,
  };
}

describe('validateCreate', () => {
  it('올바른 요청을 저장용 형태로 바꾼다', () => {
    const { errors, product } = validateCreate(base());
    expect(errors).toEqual([]);
    expect(product).not.toBeNull();
    expect(product?.transport).toBe('CAR');
    expect(product?.items).toHaveLength(3);
    // 종료 시각이 없는 항목은 기본 체류시간 보완 대상이 된다
    const noEnd = product?.items.find((i) => i.endTime === null);
    expect(noEnd?.endTimeSource).toBe('DWELL_DEFAULT');
    const withEnd = product?.items.find((i) => i.endTime !== null);
    expect(withEnd?.endTimeSource).toBe('INPUT');
  });

  it('박수와 일정 수가 안 맞으면 막는다 (EX-IN-005)', () => {
    // nights 2 는 3일치를 요구하는데 2일치만 준다
    const days = [
      { day: 1, items: [{ start: '10:00', end: '11:00', place: '경포대', itemType: 'SIGHT' }] },
      { day: 2, items: [{ start: '12:00', end: '13:00', place: '초당', itemType: 'MEAL' }] },
    ];
    const { errors, product } = validateCreate(base({ days }));
    expect(product).toBeNull();
    expect(errors.some((e) => e.includes('일치여야'))).toBe(true);
  });

  it('빈 일차를 막는다', () => {
    const days = [
      { day: 1, items: [{ start: '10:00', end: '11:00', place: '경포대', itemType: 'SIGHT' }] },
      { day: 2, items: [] },
      { day: 3, items: [{ start: '12:00', end: '13:00', place: '초당', itemType: 'MEAL' }] },
    ];
    const { errors, product } = validateCreate(base({ days }));
    expect(product).toBeNull();
    expect(errors.some((e) => e.includes('2일차'))).toBe(true);
  });

  it('스펙 밖 이동수단을 막는다', () => {
    const { errors, product } = validateCreate(base({ transport: 'walk' }));
    expect(product).toBeNull();
    expect(errors.some((e) => e.includes('이동수단'))).toBe(true);
  });

  it('잘못된 시작 시각을 막는다', () => {
    const days = [
      { day: 1, items: [{ start: '25:99', end: '11:30', place: '경포대', itemType: 'SIGHT' }] },
      { day: 2, items: [{ start: '09:00', end: '', place: '오죽헌', itemType: 'SIGHT' }] },
      { day: 3, items: [{ start: '12:00', end: '13:00', place: '초당', itemType: 'MEAL' }] },
    ];
    const { errors, product } = validateCreate(base({ days }));
    expect(product).toBeNull();
    expect(errors.some((e) => e.includes('시작 시각'))).toBe(true);
  });

  it('인원이 0 이하면 막는다', () => {
    const { errors, product } = validateCreate(base({ headCount: 0 }));
    expect(product).toBeNull();
    expect(errors.some((e) => e.includes('인원'))).toBe(true);
  });

  it('필수 기본정보가 없으면 막는다', () => {
    const { errors, product } = validateCreate(base({ name: '  ', ldongRegnCd: '' }));
    expect(product).toBeNull();
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('validateUpdate', () => {
  it('준 필드만 반영한다', () => {
    const { errors, update } = validateUpdate({ name: '새 이름', transport: 'CHARTER_BUS' });
    expect(errors).toEqual([]);
    expect(update).toEqual({ name: '새 이름', transport: 'CHARTER_BUS' });
  });

  it('빈 상품명을 막는다', () => {
    const { errors } = validateUpdate({ name: '  ' });
    expect(errors.some((e) => e.includes('상품명'))).toBe(true);
  });

  it('스펙 밖 이동수단을 막는다', () => {
    const { errors } = validateUpdate({ transport: 'bike' });
    expect(errors.some((e) => e.includes('이동수단'))).toBe(true);
  });

  it('아무것도 안 주면 빈 업데이트다', () => {
    const { errors, update } = validateUpdate({});
    expect(errors).toEqual([]);
    expect(update).toEqual({});
  });
});
