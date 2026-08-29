import { describe, expect, it } from 'vitest';
import { KtoFetchError } from '../external/kto/kto.errors';
import type { KtoClient } from '../external/kto';
import { NAME_CACHE_MAX, NAME_TTL_MS, PlaceNameResolver } from './place-name';

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
