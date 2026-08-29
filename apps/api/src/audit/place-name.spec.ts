import { describe, expect, it } from 'vitest';
import { KtoFetchError } from '../external/kto/kto.errors';
import type { KtoClient } from '../external/kto';
import {
  NAME_CACHE_MAX, NAME_TTL_MS, PlaceNameResolver, applyNames, collectPatchContentIds, replacedContentIds,
} from './place-name';

/** 부른 횟수를 셀 수 있는 공사 스텁 */
function stubKto(byId: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const kto = {
    detailCommon: async (contentId: string) => {
      calls.push(contentId);
      const found = byId[contentId];
      if (found instanceof Error) throw found;
      return (found ?? { title: `이름-${contentId}` }) as Record<string, unknown>;
    },
  } as unknown as KtoClient;
  return { kto, calls };
}

describe('대체 관광지 이름 (DR-PR-001)', () => {
  it('콘텐츠 이름을 모아 온다', async () => {
    const { kto, calls } = stubKto();
    const names = await new PlaceNameResolver({ kto }).resolve(['1', '2']);
    expect(names.get('1')).toBe('이름-1');
    expect(calls).toEqual(['1', '2']);
  });

  it('🔴 같은 콘텐츠를 두 번 부르지 않는다', async () => {
    // 한 화면에 같은 후보가 여러 finding 에 걸릴 수 있다
    const { kto, calls } = stubKto();
    await new PlaceNameResolver({ kto }).resolve(['1', '1', '2', '1']);
    expect(calls).toEqual(['1', '2']);
  });

  it('🔴 다시 열어도 다시 부르지 않는다 — 수명 안에서는', async () => {
    let now = 0;
    const { kto, calls } = stubKto();
    const r = new PlaceNameResolver({ kto, clock: () => now });

    await r.resolve(['1']);
    now += NAME_TTL_MS - 1;
    await r.resolve(['1']);
    expect(calls).toEqual(['1']);

    // 수명이 지나면 다시 본다. 오래 들고 있으면 그건 저장이다
    now += 2;
    await r.resolve(['1']);
    expect(calls).toEqual(['1', '1']);
  });

  it('🔴 못 읽은 것은 넣지 않는다 — 지어내지 않는다', async () => {
    const { kto } = stubKto({
      '2': new KtoFetchError('detailCommon2', '없는 콘텐츠'),
      '3': { title: '   ' },
      '4': {},
    });
    const names = await new PlaceNameResolver({ kto }).resolve(['1', '2', '3', '4']);
    expect([...names.keys()]).toEqual(['1']);
  });

  it('한 건이 실패해도 나머지는 준다', async () => {
    const { kto } = stubKto({ '1': new KtoFetchError('detailCommon2', '실패') });
    const names = await new PlaceNameResolver({ kto }).resolve(['1', '2']);
    expect(names.get('2')).toBe('이름-2');
  });

  it('🔴 공사 오류가 아닌 예외는 삼키지 않는다', async () => {
    // 프로그래밍 오류까지 조용히 넘기면 이름이 안 뜨는 이유를 영영 모른다
    const { kto } = stubKto({ '1': new TypeError('버그') });
    await expect(new PlaceNameResolver({ kto }).resolve(['1'])).rejects.toThrow(TypeError);
  });

  it('🔴 캐시가 무한히 자라지 않는다', async () => {
    const { kto, calls } = stubKto();
    const r = new PlaceNameResolver({ kto });
    await r.resolve(Array.from({ length: NAME_CACHE_MAX + 10 }, (_, i) => String(i)));
    calls.length = 0;
    // 가장 오래된 것은 밀려났다 — 다시 부른다
    await r.resolve(['0']);
    expect(calls).toEqual(['0']);
  });

  it('빈 id 는 부르지 않는다', async () => {
    const { kto, calls } = stubKto();
    await new PlaceNameResolver({ kto }).resolve(['', '']);
    expect(calls).toEqual([]);
  });
});

describe('전후 비교에 대체된 이름을 얹는다 (DR-PR-001)', () => {
  const row = (id: number, contentId: string | null, label: string) =>
    ({ id, ktoContentId: contentId, placeLabel: label });

  const before = [row(1, '125790', '강릉 경포대'), row(2, '2868839', '가람집옹심이'), row(3, null, '직접 입력')];

  it('🔴 콘텐츠가 바뀐 항목만 이름을 덮는다', () => {
    /*
     * `REPLACE_CONTENT` 는 `place_label` 을 건드리지 않는다 — 대체 후보의 명칭이 공사
     * 원문이라 저장할 수 없다. 그래서 전후 비교가 **같아 보였다.** 표시용으로만 덮는다.
     */
    const after = [row(1, '129784', '강릉 경포대'), row(2, '2868839', '가람집옹심이'), row(3, null, '직접 입력')];
    const named = applyNames(before, after, new Map([['129784', '강릉 오죽헌·시립박물관']]));

    expect(named[0]?.placeLabel).toBe('강릉 오죽헌·시립박물관');
    // 안 바뀐 것은 손대지 않는다
    expect(named[1]?.placeLabel).toBe('가람집옹심이');
    expect(named[2]?.placeLabel).toBe('직접 입력');
  });

  it('🔴 이름을 못 읽었으면 원래 이름을 둔다 — 지어내지 않는다', () => {
    const after = [row(1, '129784', '강릉 경포대')];
    expect(applyNames(before, after, new Map())[0]?.placeLabel).toBe('강릉 경포대');
  });

  it('🔴 안 바뀐 항목에는 이름이 있어도 안 덮는다', () => {
    // 다른 상품이 같은 콘텐츠를 쓸 수 있다. 바뀌지 않은 자리의 사용자 표기를 지우면 안 된다
    const after = [row(1, '125790', '내가 부르는 이름')];
    const named = applyNames(before, after, new Map([['125790', '강릉 경포대']]));
    expect(named[0]?.placeLabel).toBe('내가 부르는 이름');
  });

  it('물어볼 대상만 고른다', () => {
    const after = [row(1, '129784', 'x'), row(2, '2868839', 'y'), row(3, null, 'z')];
    expect(replacedContentIds(before, after)).toEqual(['129784']);
    expect(replacedContentIds(before, before)).toEqual([]);
  });
});

describe('수정안에 이름을 얹는다 (FR-PA-003)', () => {
  const run = {
    findings: [{
      patches: [
        { patchId: 'p-1', type: 'REPLACE_CONTENT', targetItemId: 1, payload: { ktoContentId: '111' } },
        { patchId: 'p-2', type: 'INSERT_ITEM', targetItemId: 1, payload: { dayNo: 1, content: { ktoContentId: '222' } } },
        { patchId: 'p-3', type: 'INSERT_ITEM', targetItemId: 1, payload: { dayNo: 1 } },
        { patchId: 'p-4', type: 'TIME_SHIFT', targetItemId: 1, payload: { newStartTime: '10:00' } },
      ],
    }],
  };

  it('🔴 대체와 추가 둘 다 이름을 물어본다', async () => {
    /*
     * 추가 수정안도 **무엇을 넣는지가 전부**다. 이름이 없으면 후보 둘이 화면에 똑같이
     * 보인다 — 「2일차에 관광 추가 (12:30~14:00)」가 두 줄로 뜬다. 실제로 그랬다.
     */
    const { kto, calls } = stubKto();
    const names = await new PlaceNameResolver({ kto }).resolve(
      collectPatchContentIds(run as never),
    );
    expect(calls.sort()).toEqual(['111', '222']);
    expect(names.get('222')).toBe('이름-222');
  });

  it('콘텐츠가 없는 추가(식사 자리)는 묻지 않는다', () => {
    // R07 식사 삽입은 자리만 만든다. 물어볼 콘텐츠가 없다
    expect(collectPatchContentIds(run as never)).toEqual(['111', '222']);
  });
});
