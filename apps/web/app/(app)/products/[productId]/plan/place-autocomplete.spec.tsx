// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { itemApi, matchApi, type ContentSearchResult, type ProductItem } from '../../../../lib/api';
import { PlaceAutocomplete } from './place-autocomplete';

// 이미 고른 줄을 다시 고른다 (FR-IN-029 · #802)
const confirmed = {
  itemId: 7, seq: 1, start: '10:00', end: '11:30', place: '강릉 경포대', itemType: 'SPOT',
  ktoContentId: '129784', matchStatus: 'CONFIRMED', mapx: 128.88, mapy: 37.77,
} as ProductItem;
const found = (contentid: string, title: string): ContentSearchResult => ({
  regionFilterApplied: true, fetchedAt: '2026-09-25T10:00:00+09:00', totalCount: 1, source: '출처: ⓒ한국관광공사',
  candidates: [{ contentid, title, addr1: null, contenttypeid: 12, cpyrhtDivCd: null }],
});
let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.spyOn(matchApi, 'match').mockResolvedValue({} as Awaited<ReturnType<typeof matchApi.match>>);
  vi.spyOn(itemApi, 'patch').mockResolvedValue({} as ProductItem);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
// 입력이 멈춘 뒤 300ms 에 검색한다
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 350)); });
async function typeInto(text: string) {
  const input = host.querySelector('input')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
  await act(async () => { input.dispatchEvent(new Event('input', { bubbles: true })); });
  await settle();
}
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label);

it('다시 고를 때는 결과가 1곳이어도 자동으로 고르지 않는다', async () => {
  vi.spyOn(matchApi, 'search').mockResolvedValue(found('129784', '강릉 경포대'));
  const resolved = vi.fn(async () => {});
  await act(async () => root.render(<PlaceAutocomplete item={confirmed} regnCd="51" signguCd="150" regionLabel="강릉시" autoPick={false} onCancel={() => {}} onResolved={resolved} />));
  await settle();
  expect(matchApi.search).toHaveBeenCalled();
  expect(matchApi.match).not.toHaveBeenCalled();
  expect(resolved).not.toHaveBeenCalled();
  expect(button('고르기')).toBeDefined();
});

it('다른 이름으로 찾아 고르면 줄 이름을 친 말로 바꾼다', async () => {
  vi.spyOn(matchApi, 'search').mockResolvedValue(found('125596', '강릉 오죽헌·시립박물관'));
  const resolved = vi.fn(async () => {});
  await act(async () => root.render(<PlaceAutocomplete item={confirmed} regnCd="51" signguCd="150" regionLabel="강릉시" autoPick={false} onResolved={resolved} />));
  await typeInto('오죽헌');
  await act(async () => { button('고르기')!.click(); });
  expect(matchApi.match).toHaveBeenCalledWith(7, '125596', 'USER');
  expect(itemApi.patch).toHaveBeenCalledWith(7, { placeLabel: '오죽헌' });
  expect(resolved).toHaveBeenCalledTimes(1);
});

it('같은 이름 그대로 고르면 줄 이름을 건드리지 않는다', async () => {
  vi.spyOn(matchApi, 'search').mockResolvedValue(found('129784', '강릉 경포대'));
  await act(async () => root.render(<PlaceAutocomplete item={confirmed} regnCd="51" signguCd="150" regionLabel="강릉시" autoPick={false} onResolved={async () => {}} />));
  await settle();
  await act(async () => { button('고르기')!.click(); });
  expect(matchApi.match).toHaveBeenCalledTimes(1);
  expect(itemApi.patch).not.toHaveBeenCalled();
});

it('「취소」 는 다시 고를 때만 보인다', async () => {
  vi.spyOn(matchApi, 'search').mockResolvedValue({ ...found('1', 'x'), candidates: [] });
  const cancel = vi.fn();
  await act(async () => root.render(<PlaceAutocomplete item={confirmed} regnCd="51" signguCd="150" regionLabel="강릉시" autoPick={false} onCancel={cancel} onResolved={async () => {}} />));
  await act(async () => { button('취소')!.click(); });
  expect(cancel).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<PlaceAutocomplete item={{ ...confirmed, matchStatus: 'PENDING' }} regnCd="51" signguCd="150" regionLabel="강릉시" onResolved={async () => {}} />));
  expect(button('취소')).toBeUndefined();
});
