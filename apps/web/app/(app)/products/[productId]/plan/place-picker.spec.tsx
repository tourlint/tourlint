// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { itemApi, planApi, type ProductDetail, type ProductItem, type PlanPlace, type PlanPlaces } from '../../../../lib/api';
import { PlacePicker } from './place-picker';
const item = { itemId: 1, place: '첫날 관광지', seq: 1, mapx: 128, mapy: 37, matchStatus: 'CONFIRMED' } as ProductItem;
const product = { productId: 42, dayCount: 2, ldongRegnCd: '51', days: [{ day: 1, items: [item] }, { day: 2, items: [{ ...item, itemId: 2, place: '둘째 날 관광지' }] }] } as ProductDetail;
const place = { contentId: '100', title: '식당 예시', contentTypeId: 39, lcls1: 'FD', lcls2: 'FD01', firstImage: null, distanceM: null, togetherRank: null, mapx: 128, mapy: 37 } as PlanPlace;
let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.spyOn(planApi, 'briefing').mockResolvedValue({ types: [], budget: 'OK', region: { regnCd: '51', signguCd: null, name: '강원' }, events: null, accessible: null, pet: null, walks: null } as Awaited<ReturnType<typeof planApi.briefing>>);
  vi.spyOn(planApi, 'events').mockResolvedValue({ items: [], window: { from: '2026-10-13', to: '2026-10-14' } });
  vi.spyOn(planApi, 'walks').mockResolvedValue({ items: [], notice: '' });
  vi.spyOn(planApi, 'places').mockResolvedValue({ items: [place], totalCount: 1, scope: { label: '근처' } } as PlanPlaces);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
it('선택한 일차의 기준 장소에 식사를 추가하고 중복 제출을 막는다', async () => {
  let finish!: (v: Awaited<ReturnType<typeof itemApi.addPicked>>) => void;
  const insert = vi.spyOn(itemApi, 'addPicked').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const inserted = vi.fn(async () => {});
  await act(async () => root.render(<PlacePicker product={product} onInserted={inserted} initialDay={2} initialAnchorId={2} initialNearKind="MEAL" />));
  expect(host.querySelectorAll('select')[1].textContent).not.toContain('첫날 관광지');
  const add = [...host.querySelectorAll('button')].find(b => b.textContent === '일정에 넣기')!;
  await act(async () => { add.click(); add.click(); });
  expect(insert).toHaveBeenCalledTimes(1);
  expect(insert).toHaveBeenCalledWith(42, expect.objectContaining({ dayNo: 2, afterItemId: 2, itemType: 'MEAL' }));
  await act(async () => finish({} as Awaited<ReturnType<typeof itemApi.addPicked>>));
  expect(inserted).toHaveBeenCalledTimes(1); expect(host.textContent).toContain('일정에 있음');
});
it('일차 변경 시 이전 날 기준 장소와 근처 검색을 초기화한다', async () => {
  await act(async () => root.render(<PlacePicker product={product} onInserted={async () => {}} initialDay={2} initialAnchorId={2} initialNearKind="MEAL" />));
  const day = host.querySelector('select')!;
  await act(async () => { day.value = '1'; day.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(host.querySelectorAll('select')[1].value).toBe('');
  expect(host.querySelectorAll('select')[1].textContent).not.toContain('둘째 날 관광지');
  expect([...host.querySelectorAll('button')].find(b => b.textContent === '식당')?.disabled).toBe(true);
});
it('기본 브리핑에 없는 부족 유형도 선택 가능하게 표시한다', async () => {
  await act(async () => root.render(<PlacePicker product={product} onInserted={async () => {}} suggestedTypes={['NA03', 'NA04']} openType="NA03" />));
  expect(host.textContent).toContain('자연생태'); expect(host.textContent).toContain('자연공원');
  expect(planApi.places).toHaveBeenCalledWith(expect.objectContaining({ lcls2: 'NA03' }));
});
