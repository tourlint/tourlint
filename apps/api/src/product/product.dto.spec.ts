import { describe, expect, it } from 'vitest';
import { validateAddItem, validateCreate, validateUpdate, validateWalkItem, type CreateProductDto } from './product.dto';

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
  // 15곳씩 세 날. n 이 45 를 넘으면 마지막 날에 더 붙인다
  const many = (n: number): CreateProductDto['days'] => [0, 1, 2].map((d) => ({
    day: d + 1,
    items: Array.from({ length: d === 2 ? n - 30 : 15 }, (_, i) => ({
      start: `${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 === 0 ? '00' : '30'}`,
      end: '', place: `장소 ${String(d * 15 + i + 1)}`, itemType: 'SIGHT',
    })),
  }));

  it('🔴 일정이 45건을 넘으면 저장 전에 거부하고 사유를 적는다 (NF-CP-003 · NF-CP-010 · #892)', () => {
    const { errors, product } = validateCreate(base({ days: many(46) }));
    expect(product).toBeNull();
    expect(errors).toContain('일정은 상품당 45건까지 넣을 수 있어요. 다른 일정을 지우거나 상품을 나눠 주세요.');
  });

  it('45건은 저장한다', () => {
    const { errors, product } = validateCreate(base({ days: many(45) }));
    expect(errors).toEqual([]);
    expect(product?.items).toHaveLength(45);
  });

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

  it('🔴 입력하는 순간 고른 관광지(content)를 CONFIRMED 저장용으로 받는다 (UI-S2-020)', () => {
    const { errors, product } = validateCreate(base({
      days: [
        { day: 1, items: [{ start: '10:00', end: '11:30', place: '경포대', itemType: 'SIGHT',
          content: { contentId: '125790', contentTypeId: 12, mapx: 128.9, mapy: 37.79, lcls1: 'HS', lcls2: 'HS01', lcls3: 'HS011200' } }] },
        { day: 2, items: [{ start: '09:00', end: '', place: '오죽헌', itemType: 'SIGHT' }] },
        { day: 3, items: [{ start: '12:00', end: '13:00', place: '초당순두부', itemType: 'MEAL' }] },
      ],
    }));
    expect(errors).toEqual([]);
    // 고른 줄은 content 가 붙고, 안 고른 줄은 null 이다 (안 고른 곳은 PENDING 으로 남는다)
    expect(product?.items[0]?.content).toMatchObject({ contentId: '125790', contentTypeId: 12 });
    expect(product?.items[1]?.content).toBeNull();
  });

  it('🔴 고른 장소 정보가 깨졌으면(contentId 없음) 거부한다', () => {
    const { errors, product } = validateCreate(base({
      days: [
        { day: 1, items: [{ start: '10:00', end: '11:30', place: '경포대', itemType: 'SIGHT', content: { contentTypeId: 12 } }] },
        { day: 2, items: [{ start: '09:00', end: '', place: '오죽헌', itemType: 'SIGHT' }] },
        { day: 3, items: [{ start: '12:00', end: '13:00', place: '초당순두부', itemType: 'MEAL' }] },
      ],
    }));
    expect(product).toBeNull();
    expect(errors.some((e) => e.includes('고른 장소 정보'))).toBe(true);
  });

  it('🔴 자유 입력이던 타깃 · 콘셉트는 표준 키만 받는다 (FR-PL-003 · DR-IN-015)', () => {
    // 되돌리기 가드: keyOrNull 검증을 빼면 '20대 커플' 이 통과해 이 검사가 빨개진다
    const bad = validateCreate(base({ targetKey: '20대 커플', conceptKey: '힐링여행' }));
    expect(bad.product).toBeNull();
    expect(bad.errors.length).toBeGreaterThan(0);

    const ok = validateCreate(base({ targetKey: 'COUPLE', conceptKey: 'EMOTIONAL' }));
    expect(ok.errors).toEqual([]);
    expect(ok.product?.targetKey).toBe('COUPLE');
    expect(ok.product?.conceptKey).toBe('EMOTIONAL');

    // 미지정은 허용한다 (아직 안 고른 상품)
    const none = validateCreate(base({ targetKey: '', conceptKey: undefined }));
    expect(none.errors).toEqual([]);
    expect(none.product?.targetKey).toBeNull();
    expect(none.product?.conceptKey).toBeNull();
  });

  it('🔴 빈 일차 · 적은 일정도 기획 중으로 저장한다 (EX-IN-005 개정 — 완성도는 검수 시작이 본다)', () => {
    // 빈 일차(2일차)와 3일치 미만도 저장 시점에는 허용한다. 빈 상품 즉시 생성.
    const days = [
      { day: 1, items: [{ start: '10:00', end: '11:00', place: '경포대', itemType: 'SIGHT' }] },
      { day: 2, items: [] },
      { day: 3, items: [{ start: '12:00', end: '13:00', place: '초당', itemType: 'MEAL' }] },
    ];
    const { errors, product } = validateCreate(base({ days }));
    expect(errors).toEqual([]);
    expect(product).not.toBeNull();
    expect(product?.items).toHaveLength(2); // 빈 일차는 항목 없이 넘어간다
  });

  it('🔴 일정이 전혀 없어도 기획 중으로 저장한다 (빈 상품 즉시 생성)', () => {
    const { errors, product } = validateCreate(base({ days: [] }));
    expect(errors).toEqual([]);
    expect(product?.items).toEqual([]);
  });

  it('🔴 박수 범위를 넘는 일차에 항목이 있으면 막는다 (데이터 정합)', () => {
    // nights 2 = 3일차까지인데 4일차에 항목을 넣으면 거부한다
    const days = [
      { day: 1, items: [{ start: '10:00', end: '11:00', place: '경포대', itemType: 'SIGHT' }] },
      { day: 2, items: [{ start: '12:00', end: '13:00', place: '초당', itemType: 'MEAL' }] },
      { day: 3, items: [{ start: '10:00', end: '11:00', place: '오죽헌', itemType: 'SIGHT' }] },
      { day: 4, items: [{ start: '10:00', end: '11:00', place: '경포호', itemType: 'SIGHT' }] },
    ];
    const { errors, product } = validateCreate(base({ days }));
    expect(product).toBeNull();
    expect(errors.some((e) => e.includes('4일차'))).toBe(true);
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

/**
 * 기존 상품 복사는 만들지 않기로 했고 FR-CM-007 도 삭제했다 (#615). 화면에도 API 에도
 * 복사 진입점이 없었는데 검증만 그 값을 받아 주고 있었다.
 */
describe('기획 출처 (DR-PR-009)', () => {
  it('🔴 CLONE 은 받지 않는다 — 기존 상품 복사는 없앴다', () => {
    const { product } = validateCreate(base({ planOrigin: { startedBy: "CLONE" } }));
    expect(product?.planOrigin).toBeNull();
  });

  it('남은 네 가지는 그대로 받는다', () => {
    for (const startedBy of ['MANUAL', 'UPLOAD', 'TEXT', 'SIGNAL']) {
      const { product } = validateCreate(base({ planOrigin: { startedBy } }));
      expect(product?.planOrigin, startedBy).toMatchObject({ startedBy });
    }
  });
});

describe('줄이 들어온 경로 (FR-PL-020)', () => {
  it('🔴 등록 화면이 보낸 경로를 줄마다 받는다 — 없거나 모르는 값이면 직접 입력', () => {
    const { product } = validateCreate(base({
      days: [
        { day: 1, items: [
          { start: '10:00', end: '11:30', place: '경포대', itemType: 'SIGHT', origin: 'TEXT' },
          { start: '12:00', end: '13:00', place: '가람집', itemType: 'MEAL', origin: 'UPLOAD' },
          { start: '14:00', end: '', place: '주문진 등대', itemType: 'SIGHT', origin: 'PICKER' },
        ] },
        { day: 2, items: [{ start: '09:00', end: '', place: '오죽헌', itemType: 'SIGHT' }] },
        // 수정안 · 레이더 소식은 화면이 보낼 수 있는 값이 아니다
        { day: 3, items: [{ start: '12:00', end: '13:00', place: '초당순두부', itemType: 'MEAL', origin: 'PATCH' }] },
      ],
    }));
    expect(product?.items.map((i) => i.origin)).toEqual(['TEXT', 'UPLOAD', 'PICKER', 'MANUAL', 'MANUAL']);
  });

  it('🔴 편집 화면의 항목 추가도 경로를 받는다', () => {
    const add = (origin?: unknown) => validateAddItem(
      { dayNo: 1, startTime: '10:00', endTime: '', placeLabel: '경포대', itemType: 'SIGHT', origin }, 3).item?.origin;
    expect(add('UPLOAD')).toBe('UPLOAD');
    expect(add('TEXT')).toBe('TEXT');
    expect(add()).toBe('MANUAL');
    expect(add('SIGNAL')).toBe('MANUAL');
  });
});

describe('직접 정한 곳으로 둔 줄 (UI-S2-021 · FR-IN-025)', () => {
  it('🔴 등록 저장 본문의 excluded: true 를 받는다 — 관광지를 고른 줄은 고른 곳이다', () => {
    const content = { contentId: '125790', contentTypeId: 12, mapx: 128.9, mapy: 37.79, lcls1: 'HS', lcls2: 'HS01' };
    const { product } = validateCreate(base({
      days: [
        { day: 1, items: [
          { start: '09:00', end: '09:30', place: '강릉역', itemType: 'MOVE', excluded: true },
          { start: '10:00', end: '11:30', place: '경포대', itemType: 'SIGHT', excluded: true, content },
          { start: '12:00', end: '13:00', place: '가람집', itemType: 'MEAL', excluded: 'yes' },
        ] },
        { day: 2, items: [] }, { day: 3, items: [] },
      ],
    }));
    expect(product?.items.map((i) => i.excluded)).toEqual([true, false, false]);
  });

  it('🔴 항목 추가의 excluded: true 도 받는다', () => {
    const add = (excluded?: unknown) => validateAddItem(
      { dayNo: 1, startTime: '10:00', endTime: '', placeLabel: '협력 공방', itemType: 'SIGHT', excluded }, 3).item?.excluded;
    expect(add(true)).toBe(true);
    expect(add()).toBe(false);
  });
});

describe('등록 화면에서 담은 걷기 길 (UI-S2-048 · DR-MD-005)', () => {
  it('🔴 excluded.walkId 줄은 장소명이 없어도 받고, 보내 온 코스 이름은 버린다', () => {
    const { errors, product } = validateCreate(base({
      days: [
        { day: 1, items: [
          { start: '09:30', end: '12:00', place: '', itemType: 'SIGHT', excluded: { walkId: 'T_CRS_MNG0000000401' }, origin: 'PICKER' },
          { start: '13:00', end: '', place: '해파랑길 35코스', itemType: 'SIGHT', excluded: { walkId: 'T_CRS_MNG0000000402' } },
        ] },
        { day: 2, items: [] }, { day: 3, items: [] },
      ],
    }));
    expect(errors).toEqual([]);
    expect(product?.items.map((i) => [i.walkId, i.placeLabel, i.excluded, i.content])).toEqual([
      ['T_CRS_MNG0000000401', '', true, null],
      ['T_CRS_MNG0000000402', '', true, null],
    ]);
  });

  it('식별자 없는 걷기 길은 거부한다', () => {
    const { errors } = validateCreate(base({
      days: [{ day: 1, items: [{ start: '09:30', end: '', place: '', itemType: 'SIGHT', excluded: {} }] }, { day: 2, items: [] }, { day: 3, items: [] }],
    }));
    expect(errors).toContain('1일차 1번 걷기 길 식별자가 필요합니다.');
  });

  it('🔴 편집 화면의 걷기 길 추가는 정한 시각을 받는다 — 없으면 전처럼 비워 둔다', () => {
    const walk = (over: Record<string, unknown>) => validateWalkItem({ dayNo: 1, excluded: { walkId: 'W1' }, ...over }, 3);
    expect(walk({ startTime: '09:30', endTime: '12:00' }).walk).toMatchObject({ startTime: '09:30', endTime: '12:00' });
    expect(walk({}).walk).toMatchObject({ startTime: null, endTime: null });
    expect(walk({ startTime: '9시' }).errors).toContain('시작 시각을 HH:MM 형식으로 입력하세요.');
    expect(walk({ endTime: '12:00' }).errors).toContain('종료 시각만 보낼 수는 없습니다.');
  });
});
