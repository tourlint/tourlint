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
