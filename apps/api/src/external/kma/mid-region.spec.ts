import { describe, expect, it } from 'vitest';
import { MID_LAND_REGION, midLandRegionOf } from './mid-region';

describe('중기 예보구역 매핑 (EI-WX-003)', () => {
  it('여러 시도가 한 구역을 함께 쓴다', () => {
    for (const sido of ['11', '28', '41']) {
      expect(midLandRegionOf(sido, '110')).toBe(MID_LAND_REGION.SEOUL_INCHEON_GYEONGGI);
    }
  });

  it('🔴 강원은 시군구로 영서 · 영동이 갈린다', () => {
    expect(midLandRegionOf('51', '150')).toBe(MID_LAND_REGION.GANGWON_YEONGDONG); // 강릉
    expect(midLandRegionOf('51', '110')).toBe(MID_LAND_REGION.GANGWON_YEONGSEO); // 춘천
  });

  it('🔴 태백(190)은 영서 · 영동을 확인하지 못해 고르지 않는다', () => {
    // 찍어 넣으면 태백 상품의 강수확률이 통째로 다른 구역 값이 된다 (FR-RU-051)
    expect(midLandRegionOf('51', '190')).toBeNull();
    expect(midLandRegionOf('42', '51190')).toBeNull();
  });

  it('강원인데 시군구를 모르면 구역을 고르지 않는다', () => {
    expect(midLandRegionOf('51', null)).toBeNull();
    expect(midLandRegionOf('51', '')).toBeNull();
  });

  it('강원 특별자치도 전환 전 코드(42)도 받는다', () => {
    expect(midLandRegionOf('42', '210')).toBe(MID_LAND_REGION.GANGWON_YEONGDONG); // 속초
  });

  it('시군구 코드 길이를 가정하지 않는다 (DR-IN-010)', () => {
    expect(midLandRegionOf('51', '51150')).toBe(MID_LAND_REGION.GANGWON_YEONGDONG);
    expect(midLandRegionOf('51', '51110')).toBe(MID_LAND_REGION.GANGWON_YEONGSEO);
  });

  it('전북 · 제주 특별자치도 코드', () => {
    expect(midLandRegionOf('52', null)).toBe(MID_LAND_REGION.JEONBUK);
    expect(midLandRegionOf('45', null)).toBe(MID_LAND_REGION.JEONBUK);
    expect(midLandRegionOf('50', null)).toBe(MID_LAND_REGION.JEJU);
  });

  it('전남광주통합특별시(12) — 공사 시도 목록 실측 코드 (EI-KT-014)', () => {
    expect(midLandRegionOf('12', null)).toBe(MID_LAND_REGION.GWANGJU_JEONNAM);
  });

  it('모르는 시도는 가까운 구역으로 대신 넣지 않는다 (FR-RU-051)', () => {
    expect(midLandRegionOf('99', '110')).toBeNull();
    expect(midLandRegionOf(null, '110')).toBeNull();
  });

  it('구역 코드는 10개이고 중복이 없다', () => {
    const ids = Object.values(MID_LAND_REGION);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    for (const id of ids) expect(id).toMatch(/^11[A-H]\d{5}$/);
  });
});
