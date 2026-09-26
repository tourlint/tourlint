import { expect, it } from 'vitest';
import { reviewPlaceContext } from './review-place-context';
import type { Finding, ProductDetail, ProductItem } from '../../../lib/api';
const item = { itemId: 1, end: '13:30', matchStatus: 'CONFIRMED', mapx: 128, mapy: 37 } as ProductItem;
const product = { days: [{ day: 1, items: [item] }, { day: 2, items: [{ ...item, itemId: 2 }, { ...item, itemId: 3, end: '17:00' }] }] } as ProductDetail;
it('식사 경고의 일차와 그날 점심 전 마지막 장소로 찾기를 연다', () => {
  expect(reviewPlaceContext(product, { ruleCode: 'R07', evidenceView: { verdict: { dayNo: 2 } } } as Finding)).toMatchObject({ initialDay: 2, initialAnchorId: 2, initialNearKind: 'MEAL' });
});
it('부족한 종류를 기본 선택하고 알 수 없는 코드는 검색하지 않는다', () => {
  expect(reviewPlaceContext(product, { ruleCode: 'R10', evidenceView: { verdict: { missingLcls2: ['NA01', 'NA03', 'UNKNOWN'] } } } as Finding)).toMatchObject({ openType: 'NA01', suggestedTypes: ['NA01', 'NA03'] });
});
it('확정 좌표가 없으면 근처 검색을 켜지 않는다', () => {
  expect(reviewPlaceContext({ days: [{ day: 2, items: [{ ...item, mapx: null }] }] } as ProductDetail, { ruleCode: 'R07' } as Finding)).toMatchObject({ initialDay: 2, initialAnchorId: null, initialNearKind: null });
});
it('🔴 R04 는 반복된 종류를 뺀 관광 종류를 골라 연다 — 바다 풍경이 몰렸으면 랜드마크부터 (UI-S3-028)', () => {
  // 가이드 강릉 상품의 「바다 · 강 풍경 4곳」
  const sea = { ruleCode: 'R04', evidenceView: { verdict: { axis: 'lclsSystm3', scope: 'PRODUCT', dayNo: null, key: 'NA020100', count: 4, threshold: 3 } } } as Finding;
  expect(reviewPlaceContext(product, sea)).toMatchObject({ openType: 'VE01', suggestedTypes: ['VE01', 'VE07', 'EX02'] });
  // 「관광지 7곳」 — 관광지 유형으로 오는 종류를 빼면 전시시설(문화시설)이 남는다. 그 일차로 연다
  const sights = { ruleCode: 'R04', evidenceView: { verdict: { axis: 'contentTypeId', scope: 'DAY', dayNo: 2, key: '12', count: 7, threshold: 3 } } } as Finding;
  expect(reviewPlaceContext(product, sights)).toMatchObject({ initialDay: 2, openType: 'VE07', suggestedTypes: ['VE07'] });
});
it('R04 는 쏠린 종류를 모르면 아무 종류도 고르지 않는다 — R10 의 부족한 종류 칸을 읽지 않는다', () => {
  expect(reviewPlaceContext(product, { ruleCode: 'R04', evidenceView: { verdict: { missingLcls2: ['NA01'] } } } as Finding).openType).toBeNull();
});
