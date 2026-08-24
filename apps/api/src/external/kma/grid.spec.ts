import { describe, expect, it } from 'vitest';
import { representativePoint, toGrid } from './grid';

/**
 * 격자 변환 — 순수 함수라 DB 도 네트워크도 없이 본다.
 *
 * 기대값은 기상청이 배포하는 격자 대조표의 값이고, 2026-08-24 실호출로 해당 격자에
 * 실제 예보가 오는 것까지 확인했다.
 */

describe('위경도 → 기상청 격자 (EI-WX-002)', () => {
  it.each([
    ['서울 종로', 126.978, 37.5665, 60, 127],
    ['속초', 128.5918, 38.207, 87, 141],
    ['제주', 126.5312, 33.4996, 53, 38],
  ])('%s 는 nx=%d ny=%d 로 떨어진다', (_name, lon, lat, nx, ny) => {
    expect(toGrid(lon as number, lat as number)).toEqual({ nx, ny });
  });

  it('좌표가 없으면 지어내지 않는다', () => {
    expect(toGrid(null, 37.5)).toBeNull();
    expect(toGrid(126.9, null)).toBeNull();
    expect(toGrid(null, null)).toBeNull();
  });

  it('숫자가 아닌 값도 막는다 — NaN 을 넘기면 격자도 NaN 이 된다', () => {
    expect(toGrid(Number.NaN, 37.5)).toBeNull();
    expect(toGrid(126.9, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('같은 도시 안에서는 대개 같은 격자다 — 항목마다 부를 이유가 없다', () => {
    // 강릉 시내 두 지점. 5km 격자라 붙어 있다
    const a = toGrid(128.8761, 37.7519);
    const b = toGrid(128.8961, 37.7952);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(Math.abs((a?.nx ?? 0) - (b?.nx ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((a?.ny ?? 0) - (b?.ny ?? 0))).toBeLessThanOrEqual(1);
  });
});

describe('대표 지점 (EI-WX-002)', () => {
  const at = (mapX: number | null, mapY: number | null) => ({ mapX, mapY });

  it('좌표가 있는 항목들의 평균이다', () => {
    expect(representativePoint([at(128.0, 37.0), at(130.0, 39.0)])).toEqual({ lon: 129.0, lat: 38.0 });
  });

  it('🔴 첫 항목이 아니라 평균이다 — 외곽 하나가 온 상품의 격자를 끌고 가면 안 된다', () => {
    const point = representativePoint([at(126.0, 33.0), at(129.0, 37.5), at(129.0, 37.5)]);
    expect(point?.lon).not.toBe(126.0);
    expect(point?.lat).not.toBe(33.0);
  });

  it('좌표 없는 항목은 평균에서 뺀다', () => {
    expect(representativePoint([at(128.0, 37.0), at(null, null), at(130.0, 39.0)]))
      .toEqual({ lon: 129.0, lat: 38.0 });
  });

  it('좌표가 하나도 없으면 null — R09 는 확인 불가로 남는다', () => {
    expect(representativePoint([at(null, null), at(null, null)])).toBeNull();
    expect(representativePoint([])).toBeNull();
  });
});
