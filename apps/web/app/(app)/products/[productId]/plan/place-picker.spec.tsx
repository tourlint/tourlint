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

// 장소 담기 칸 (UI-S2-036 · 037 · 038 · 043 · EX-PL-002)
const briefing = (over: Partial<Awaited<ReturnType<typeof planApi.briefing>>> = {}) => ({
  region: { regnCd: '51', signguCd: '150', name: '강릉시' }, budget: 'OK' as const,
  types: [{ kind: 'LCLS2' as const, lcls2: 'VE07', nearKind: null, name: '전시시설', count: 25, disabled: null }],
  events: { count: 0, from: '2026-11-14', to: '2026-11-22' }, accessible: { count: 30 }, pet: { count: 4 }, walks: { count: 2 }, ...over,
});
const text = () => host.textContent ?? '';
const btn = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label);
const box = (label: string) => [...host.querySelectorAll('label')].find(l => l.textContent?.startsWith(label))?.querySelector('input') ?? null;
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const renderPicker = async (props: Partial<Parameters<typeof PlacePicker>[0]> = {}) => {
  await act(async () => root.render(<PlacePicker product={{ ...product, region: { regnName: '강원특별자치도', signguName: '강릉시' } } as ProductDetail} onInserted={async () => {}} {...props} />));
  await settle();
};

it('🔴 칸을 접고 펼친다 — 처음에는 펼쳐 둔다 (UI-S2-036)', async () => {
  vi.spyOn(planApi, 'briefing').mockResolvedValue(briefing());
  await renderPicker();
  expect(btn('접기')?.getAttribute('aria-expanded')).toBe('true');
  expect(text()).toContain('전시시설');
  await act(async () => btn('접기')!.click());
  expect(text()).not.toContain('전시시설');
  expect(host.querySelector('select')).toBeNull();
  await act(async () => btn('펼치기')!.click());
  expect(text()).toContain('전시시설');
});

it('🔴 줄 머리 「(시군구) 전체」 · 「(앞 장소) 근처 3km」, 누른 칩의 개수, 가까운 순 안내 (UI-S2-037)', async () => {
  vi.spyOn(planApi, 'briefing').mockResolvedValue(briefing());
  await renderPicker({ initialDay: 2, initialAnchorId: 2, initialNearKind: 'MEAL' });
  expect(text()).toContain('강릉시 전체');
  expect(text()).toContain('둘째 날 관광지 근처 3km');
  expect(text()).toContain('식당 · 카페 · 숙소는 가까운 순으로 보여 드려요');
  expect(btn('식당1')).toBeDefined();
  expect(btn('카페')).toBeDefined();
});

it('🔴 필터가 켜지면 「필터 끄기」, 누르면 모두 끈다 (UI-S2-038)', async () => {
  vi.spyOn(planApi, 'briefing').mockResolvedValue(briefing());
  await renderPicker({ openType: 'VE07' });
  expect(btn('필터 끄기')).toBeUndefined();
  await act(async () => box('휠체어 가능')!.click());
  expect(planApi.places).toHaveBeenLastCalledWith(expect.objectContaining({ wheelchair: true }));
  await act(async () => btn('필터 끄기')!.click());
  expect(box('휠체어 가능')!.checked).toBe(false);
  expect(planApi.places).toHaveBeenLastCalledWith(expect.objectContaining({ wheelchair: false }));
});

it('🔴 무장애 · 반려동물 · 걷기 길을 못 받으면 그 필터 · 칸만 「지금은 볼 수 없어요」 (UI-S2-043)', async () => {
  vi.spyOn(planApi, 'briefing').mockResolvedValue(briefing({ accessible: null, walks: null }));
  await renderPicker({ openType: 'VE07' });
  const wheelchair = [...host.querySelectorAll('label')].find(l => l.textContent?.startsWith('휠체어 가능'))!;
  expect(wheelchair.textContent).toContain('지금은 볼 수 없어요');
  expect(wheelchair.querySelector('input')!.disabled).toBe(true);
  expect(box('반려동물 동반')!.disabled).toBe(false);
  expect(planApi.places).toHaveBeenLastCalledWith(expect.objectContaining({ wheelchair: false }));
  const walks = [...host.querySelectorAll('h3')].find(h => h.textContent === '걷기 길')?.parentElement;
  expect(walks?.textContent).toContain('지금은 볼 수 없어요');
});

it('🔴 행사가 0건이면 칸을 숨기지 않고 한 줄로, 못 받았으면 따로 적는다 (EX-PL-002)', async () => {
  vi.spyOn(planApi, 'briefing').mockResolvedValue(briefing());
  await renderPicker();
  const events = () => [...host.querySelectorAll('h3')].find(h => h.textContent === '행사 · 공연')?.parentElement?.textContent ?? '';
  expect(events()).toContain('여행 날짜 앞뒤 3일에 등록된 행사가 없어요');
  expect(events()).not.toContain('출발일을');

  await act(async () => root.unmount()); root = createRoot(host);
  vi.spyOn(planApi, 'events').mockRejectedValue(new TypeError('Failed to fetch'));
  await renderPicker();
  expect(events()).toContain('지금은 볼 수 없어요');
  expect(events()).not.toContain('등록된 행사가 없어요');
});

it('🔴 빈 「넣을 위치」는 동작대로 「맨 뒤」 — 넣으면 그 일차 끝에 붙는다 (UI-S2-039)', async () => {
  vi.spyOn(planApi, 'briefing').mockResolvedValue(briefing());
  const insert = vi.spyOn(itemApi, 'addPicked').mockResolvedValue({} as Awaited<ReturnType<typeof itemApi.addPicked>>);
  await renderPicker({ openType: 'VE07' });
  const anchorSelect = host.querySelectorAll('select')[1]!;
  expect(anchorSelect.value).toBe('');
  expect(anchorSelect.options[0]?.textContent).toBe('맨 뒤');
  expect(text()).not.toContain('고른 장소 다음');
  await act(async () => btn('일정에 넣기')!.click());
  expect(insert).toHaveBeenCalledWith(42, expect.objectContaining({ dayNo: 1, afterItemId: null }));
});

it('🔴 「자세히」에 상품 타깃을 넘긴다 — 단체 · 모임은 주차가 앞 (UI-S2-040)', async () => {
  vi.spyOn(planApi, 'briefing').mockResolvedValue(briefing());
  vi.spyOn(planApi, 'placeDetail').mockResolvedValue({ contentId: '100', hours: '11:00~21:00', restDays: null, fee: null, parking: '가능', eventPeriod: null, contact: null });
  await act(async () => root.render(<PlacePicker product={{ ...product, targetKey: 'GROUP', region: { regnName: '강원특별자치도', signguName: '강릉시' } } as ProductDetail} onInserted={async () => {}} openType="VE07" />));
  await settle();
  await act(async () => btn('자세히')!.click());
  await settle();
  const t = text();
  expect(t.indexOf('주차')).toBeGreaterThan(-1);
  expect(t.indexOf('주차')).toBeLessThan(t.indexOf('이용시간'));
});
