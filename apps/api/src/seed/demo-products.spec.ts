import { describe, expect, it } from 'vitest';
import { TARGET_PROFILE_SEED } from '@tourlint/shared';
import { DEMO_PRODUCTS } from './demo-products';

/**
 * 생성된 데모 데이터가 DB 제약을 그대로 만족하는지 본다. 시드가 DB 에 닿기 전에 깨진 행을
 * 잡는다 — fixtures 를 다시 뽑았을 때 스키마와 어긋나면 여기서 빨개진다.
 *
 * DB 를 띄우지 않고 도는 순수 검사라, 스키마 CHECK 제약(item_type·transport·match)과 트리거
 * (day_no ≤ nights+1)를 코드로 옮겨 대조한다.
 */

const TRANSPORTS = ['CHARTER_BUS', 'CAR', 'PUBLIC_TRANSIT'];
const ITEM_TYPES = ['SIGHT', 'MEAL', 'LODGING', 'REST', 'MOVE', 'FREE'];
const END_SOURCES = ['INPUT', 'DWELL_DEFAULT', 'DWELL_FALLBACK'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

describe('DEMO_PRODUCTS', () => {
  it('시연 상품이 하나 이상 있다', () => {
    expect(DEMO_PRODUCTS.length).toBeGreaterThan(0);
  });

  it.each(DEMO_PRODUCTS.map((p) => [p.name, p] as const))('상품 제약을 만족한다 — %s', (_name, product) => {
    expect(product.nights, 'nights BETWEEN 0 AND 2').toBeGreaterThanOrEqual(0);
    expect(product.nights).toBeLessThanOrEqual(2);
    expect(TRANSPORTS, 'ck_product_transport').toContain(product.transport);
    expect(product.ldongRegnCd, 'ldong_regn_cd NOT NULL').not.toBe('');
    if (product.headCount !== null) {
      expect(product.headCount, 'ck_product_headcount > 0').toBeGreaterThan(0);
    }
    expect(product.items.length, '항목이 있어야 대시보드에 뜬다').toBeGreaterThan(0);
  });

  it('🔴 타깃 · 콘셉트가 코드다 — 한글 라벨이면 R10 이 프로파일을 못 찾는다', () => {
    /*
     * `target_profile` 은 코드(`YOUTH_20S` · `EMOTIONAL` …)로 저장된다. 시드가 한글 라벨
     * (`"20대"` · `"감성"`)을 담고 있어 R10 이 어느 행도 못 찾고 판정 대신 확인 불가를
     * 냈다 — TP-03 이 명세 AC 의 29점이 아니라 27점이었다 (이슈 #310).
     */
    const targets = new Set(TARGET_PROFILE_SEED.map((p) => p.targetKey));
    const concepts = new Set(TARGET_PROFILE_SEED.map((p) => p.conceptKey));
    for (const product of DEMO_PRODUCTS) {
      if (product.targetKey === null && product.conceptKey === null) continue;
      expect(targets, `${product.name} targetKey`).toContain(product.targetKey);
      expect(concepts, `${product.name} conceptKey`).toContain(product.conceptKey);
    }
  });

  it.each(DEMO_PRODUCTS.map((p) => [p.name, p] as const))('항목 제약을 만족한다 — %s', (_name, product) => {
    const maxDay = product.nights + 1;
    const seen = new Set<string>();
    for (const item of product.items) {
      expect(item.dayNo, 'ck_item_day_no >= 1').toBeGreaterThanOrEqual(1);
      expect(item.dayNo, 'trg_check_item_day_no: day_no ≤ nights+1').toBeLessThanOrEqual(maxDay);
      expect(ITEM_TYPES, 'ck_item_type').toContain(item.itemType);
      expect(END_SOURCES, 'ck_item_end_src').toContain(item.endTimeSource);
      expect(item.startTime, 'start_time HH:mm').toMatch(HHMM);
      if (item.endTime !== null) expect(item.endTime, 'end_time HH:mm').toMatch(HHMM);
      // INPUT 이면 종료 시각이 있어야 하고, 없으면 기본값 계열이어야 한다
      if (item.endTimeSource === 'INPUT') expect(item.endTime).not.toBeNull();
      // CONFIRMED 로 넣으므로 contentid 가 반드시 있어야 한다 (ck_item_match_content · DR-IN-004)
      expect(item.ktoContentId, 'CONFIRMED 는 contentid 필수').toBeTruthy();

      /*
       * 좌표가 없으면 R08 이 그 구간을 COORD_MISSING 으로 넘겨 길찾기를 부르지 않는다
       * (audit-runner.ts). 시드는 F02 매칭 경로를 건너뛰므로 여기서 빠지면 아무도 못 잡는다 —
       * 2026-08-31 성능 실측에서 데모 4개 상품 전부가 이동시간 확인 불가인 채로 발견됐다.
       * 강릉이므로 경도 128 · 위도 37 대다. 0 이나 뒤바뀐 값도 걸러야 한다.
       */
      expect(item.mapx, 'mapx 없음 — R08 이 COORD_MISSING 으로 넘어간다').toBeGreaterThan(124);
      expect(item.mapx, 'mapx 가 경도 범위를 벗어난다').toBeLessThan(132);
      expect(item.mapy, 'mapy 없음 — R08 이 COORD_MISSING 으로 넘어간다').toBeGreaterThan(33);
      expect(item.mapy, 'mapy 가 위도 범위를 벗어난다').toBeLessThan(39);

      const key = `${item.dayNo}-${item.seq}`;
      expect(seen.has(key), `uq_item_product_day_seq 중복: ${key}`).toBe(false);
      seen.add(key);
    }
  });
});
