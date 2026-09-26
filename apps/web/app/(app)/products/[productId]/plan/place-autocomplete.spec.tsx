// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { itemApi, matchApi, type ContentSearchResult, type ProductItem } from '../../../../lib/api';
import { PlaceAutocomplete, noNameHint } from './place-autocomplete';

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
  vi.spyOn(matchApi, 'exclude').mockResolvedValue({ itemId: 8, matchStatus: 'EXCLUDED' });
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

// 기획 화면의 고르지 않은 줄 (UI-S2-034 · UI-S2-045 · EX-MC-004)
const pending = { ...confirmed, itemId: 8, place: '경포해변', ktoContentId: null, matchStatus: 'PENDING', mapx: null, mapy: null } as ProductItem;
const none = (): ContentSearchResult => ({ ...found('1', 'x'), candidates: [], totalCount: 0 });
const two = (): ContentSearchResult => ({ ...found('1', '경포해수욕장'), candidates: [...found('1', '경포해수욕장').candidates, ...found('2', '경포 해변 공원').candidates], totalCount: 2 });

function Row({ inCard = false, onResolved = async () => {} }: { inCard?: boolean; onResolved?: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  return <PlaceAutocomplete item={pending} regnCd="51" signguCd="150" regionLabel="강릉시" folded={!open || inCard} hideActions={inCard}
    onOpen={() => setOpen(true)} autoFocus onResolved={onResolved} />;
}

it('🔴 고르지 않은 줄은 접혀 「아직 고르지 않음」 과 두 버튼만 보인다', async () => {
  vi.spyOn(matchApi, 'search').mockResolvedValue(two());
  await act(async () => root.render(<Row />));
  await settle();
  expect(host.textContent).toContain('아직 고르지 않음');
  expect(button('장소 찾기')).toBeDefined();
  expect(button('직접 정한 곳으로 두기')).toBeDefined();
  expect(host.querySelector('input')).toBeNull();
  expect(host.textContent).not.toContain('경포해수욕장');
});

it('🔴 접혀 있어도 처음 검색에서 1곳이면 자동으로 고른다 (AUTO 그대로)', async () => {
  vi.spyOn(matchApi, 'search').mockResolvedValue(found('128758', '경포해수욕장'));
  const resolved = vi.fn(async () => {});
  await act(async () => root.render(<Row onResolved={resolved} />));
  await settle();
  expect(matchApi.match).toHaveBeenCalledWith(8, '128758', 'AUTO');
  expect(resolved).toHaveBeenCalledTimes(1);
});

it('🔴 에이전트 카드가 이 줄을 다루는 동안에는 두 버튼을 숨긴다', async () => {
  vi.spyOn(matchApi, 'search').mockResolvedValue(two());
  await act(async () => root.render(<Row inCard />));
  await settle();
  expect(host.textContent).toContain('아직 고르지 않음');
  expect(button('장소 찾기')).toBeUndefined();
  expect(button('직접 정한 곳으로 두기')).toBeUndefined();
});

it('🔴 [장소 찾기]는 장소 칸을 글자 전체 선택 상태로 열고 목록을 띄운다', async () => {
  vi.spyOn(matchApi, 'search').mockResolvedValue(two());
  await act(async () => root.render(<Row />));
  await settle();
  await act(async () => { button('장소 찾기')!.click(); });
  const input = host.querySelector('input')!;
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, '경포해변'.length]);
  expect(host.textContent).toContain('강릉시에서 찾은 곳 2곳');
  // 접혀 있을 때 이미 찾았다 — 펼친다고 다시 부르지 않는다
  expect(matchApi.search).toHaveBeenCalledTimes(1);
});

it('🔴 검색 호출이 실패하면 0곳 문구 대신 실패와 다시 시도를 보인다 (EX-MC-004)', async () => {
  const search = vi.spyOn(matchApi, 'search').mockRejectedValueOnce({ status: 502, message: '일시적으로 조회할 수 없습니다.' }).mockResolvedValue(two());
  await act(async () => root.render(<PlaceAutocomplete item={pending} regnCd="51" signguCd="150" regionLabel="강릉시" onResolved={async () => {}} />));
  await settle();
  expect(host.textContent).toContain('일시적으로 조회할 수 없습니다.');
  expect(host.textContent).not.toContain('관광정보에 올라 있는 이름으로');
  expect(matchApi.exclude).not.toHaveBeenCalled();
  await act(async () => { button('다시 시도')!.click(); });
  await settle();
  expect(search).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain('강릉시에서 찾은 곳 2곳');
});

it('0곳이면 관광정보에 올라 있는 이름으로 검색해 보라고 한다', async () => {
  vi.spyOn(matchApi, 'search').mockResolvedValue(none());
  await act(async () => root.render(<PlaceAutocomplete item={pending} regnCd="51" signguCd="150" regionLabel="강릉시" onResolved={async () => {}} />));
  await settle();
  expect(host.textContent).toContain('관광정보에 올라 있는 이름으로 검색해 보세요');
});

it('🔴 이름이 없다고 본 줄은 그 문구로 검색하지 않고 유형에 맞는 안내를 보인다 (UI-S2-045)', async () => {
  vi.spyOn(matchApi, 'search').mockResolvedValue(two());
  const lunch = { ...pending, place: '점심', itemType: 'MEAL' } as ProductItem;
  await act(async () => root.render(<PlaceAutocomplete item={lunch} initialKeyword="" autoFocus regnCd="51" signguCd="150" regionLabel="강릉시" onResolved={async () => {}} />));
  await settle();
  expect(matchApi.search).not.toHaveBeenCalled();
  expect(host.textContent).toContain('식당 이름을 적어 보세요 · 이름을 모르면 오른쪽 장소 담기에서 근처 식당을 골라 보세요');
  expect(noNameHint('LODGING')).toBe('숙소 이름을 적어 보세요 · 이름을 모르면 오른쪽 장소 담기에서 근처 숙소를 골라 보세요');
});
