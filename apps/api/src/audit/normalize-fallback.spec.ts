import { describe, expect, it } from 'vitest';
import { LlmClient, LlmUnavailableError, type LlmProvider, type LlmStructuredResult } from '../external/llm';
import type { NormalizedOperatingInfo, UnparsedFragment } from '../engine/normalize/types';
import type { CachedParse, LlmParseCacheRepository } from '../persistence/llm-parse-cache.repository';
import { applyNormalizeFallback, MAX_FRAGMENTS_PER_CONTENT } from './normalize-fallback';

const CONFIG = { provider: 'anthropic', modelStructure: 'm-s', modelNormalize: 'm-n', apiKey: 'k' };

function frag(fragment: string): UnparsedFragment {
  return { fragment, reason: 'MISSING', affects: ['weeklyClosed'] };
}

function normalized(unparsed: readonly UnparsedFragment[]): NormalizedOperatingInfo {
  return {
    schemaVersion: '1.0', sourceFieldNames: ['restdate'],
    alwaysOpen: false, weeklyClosed: [], nthWeekday: [], fixedClosed: [],
    holidayRule: [], conditionalRule: [], partialClosed: [],
    openHours: null, dayOfWeekHours: [], seasonalHours: [],
    checkIn: null, checkOut: null,
    confidence: { overall: 'UNPARSED', byPath: {} },
    unparsed,
  } as NormalizedOperatingInfo;
}

/** 부른 횟수를 세는 가짜 LLM */
function fakeLlm(answer: unknown | (() => never)): { llm: LlmClient; calls: () => number } {
  let n = 0;
  const provider: LlmProvider = {
    name: 'fake',
    structured: async (): Promise<LlmStructuredResult> => {
      n += 1;
      if (typeof answer === 'function') (answer as () => never)();
      return { value: answer, model: 'm-n' };
    },
  };
  return { llm: new LlmClient({ provider, config: CONFIG }), calls: () => n };
}

/** 메모리 캐시. 실제 저장소와 같은 모양만 만족하면 된다 */
function fakeCache(): LlmParseCacheRepository & { size: () => number } {
  const store = new Map<string, CachedParse>();
  return {
    find: async (h: string) => store.get(h) ?? null,
    findMany: async (hs: readonly string[]) =>
      new Map([...store].filter(([k]) => hs.includes(k))),
    put: async (h: string, _p: unknown, model: string, result: unknown) => {
      if (!store.has(h)) store.set(h, { result, model });
    },
    size: () => store.size,
  } as unknown as LlmParseCacheRepository & { size: () => number };
}

describe('정규화 폴백', () => {
  it('미해석 조각을 해석해 합친다 (FR-AU-010)', async () => {
    const { llm } = fakeLlm({ weeklyClosed: ['MON'] });
    const out = await applyNormalizeFallback(normalized([frag('월요일 쉼')]), { llm, cache: fakeCache() });
    expect(out.weeklyClosed).toEqual(['MON']);
    expect(out.unparsed).toEqual([]);
  });

  it('🔴 두 번째 검수는 LLM 을 부르지 않는다 — 캐시가 NF-MT-001 을 지킨다', async () => {
    const { llm, calls } = fakeLlm({ weeklyClosed: ['MON'] });
    const cache = fakeCache();
    const input = normalized([frag('월요일 쉼')]);

    const first = await applyNormalizeFallback(input, { llm, cache });
    const second = await applyNormalizeFallback(input, { llm, cache });
    const third = await applyNormalizeFallback(input, { llm, cache });

    expect(calls()).toBe(1);
    expect(second.weeklyClosed).toEqual(first.weeklyClosed);
    expect(third.weeklyClosed).toEqual(first.weeklyClosed);
  });

  it('🔴 세 번 돌려도 결과가 완전히 같다 (NF-MT-001)', async () => {
    const { llm } = fakeLlm({ weeklyClosed: ['MON'], openHours: { open: '09:00', close: '18:00' } });
    const cache = fakeCache();
    const input = normalized([frag('월요일 쉼 09~18시')]);
    const runs = [
      await applyNormalizeFallback(input, { llm, cache }),
      await applyNormalizeFallback(input, { llm, cache }),
      await applyNormalizeFallback(input, { llm, cache }),
    ].map((r) => JSON.stringify(r));
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });

  it('🔴 LLM 이 실패하면 조각을 그대로 두고 검수는 계속된다 (FR-AU-010)', async () => {
    const { llm } = fakeLlm(() => { throw new LlmUnavailableError('down'); });
    const f = frag('월요일 쉼');
    const out = await applyNormalizeFallback(normalized([f]), { llm, cache: fakeCache() });
    expect(out.unparsed).toEqual([f]);
    expect(out.weeklyClosed).toEqual([]);
  });

  it('🔴 실패를 캐시하지 않는다 — 일시적 장애가 영영 굳으면 안 된다', async () => {
    const cache = fakeCache();
    const down = fakeLlm(() => { throw new LlmUnavailableError('down'); });
    await applyNormalizeFallback(normalized([frag('월요일 쉼')]), { llm: down.llm, cache });
    expect((cache as unknown as { size: () => number }).size()).toBe(0);

    // 살아난 뒤에는 읽는다
    const up = fakeLlm({ weeklyClosed: ['MON'] });
    const out = await applyNormalizeFallback(normalized([frag('월요일 쉼')]), { llm: up.llm, cache });
    expect(out.weeklyClosed).toEqual(['MON']);
  });

  it('🔴 검증을 못 지난 응답은 캐시하지 않는다 — 매번 다시 버리게 된다', async () => {
    const cache = fakeCache();
    const { llm } = fakeLlm({ weeklyClosed: ['MONDAY'] });
    const f = frag('월요일 쉼');
    const out = await applyNormalizeFallback(normalized([f]), { llm, cache });
    expect(out.unparsed).toEqual([f]);
    expect((cache as unknown as { size: () => number }).size()).toBe(0);
  });

  it('LLM 이 없으면 아무것도 하지 않는다', async () => {
    const input = normalized([frag('월요일 쉼')]);
    const out = await applyNormalizeFallback(input, { llm: null, cache: fakeCache() });
    expect(out).toBe(input);
  });

  it('미해석 조각이 없으면 부르지 않는다 — 대부분의 콘텐츠가 그렇다', async () => {
    const { llm, calls } = fakeLlm({ weeklyClosed: ['MON'] });
    await applyNormalizeFallback(normalized([]), { llm, cache: fakeCache() });
    expect(calls()).toBe(0);
  });

  it(`🔴 콘텐츠당 조각 ${String(MAX_FRAGMENTS_PER_CONTENT)}개까지만 부른다 — 예산이 새면 안 된다`, async () => {
    const { llm, calls } = fakeLlm({ weeklyClosed: ['MON'] });
    const many = Array.from({ length: 10 }, (_, i) => frag(`조각 ${String(i)}`));
    await applyNormalizeFallback(normalized(many), { llm, cache: fakeCache() });
    expect(calls()).toBe(MAX_FRAGMENTS_PER_CONTENT);
  });
});
