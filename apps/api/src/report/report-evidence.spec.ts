import { describe, expect, it } from 'vitest';
import type { KtoClient } from '../external/kto';
import { ContentNotFoundError, KtoFetchError } from '../external/kto';
import { collectEvidence } from './report-evidence';
import type { FingerprintRow } from './report.repository';

function fp(over: Partial<FingerprintRow> = {}): FingerprintRow {
  return {
    ktoContentId: '126508', contentTypeId: 12, showFlag: 1,
    ktoModifiedTime: '20260801120000', fieldHash: 'a'.repeat(64), ...over,
  };
}

interface Calls { readonly common: string[]; readonly intro: string[] }

function fakeKto(over: Partial<{
  common: () => Promise<Record<string, unknown>>;
  intro: () => Promise<Record<string, unknown>>;
}> = {}): { kto: KtoClient; calls: Calls } {
  const calls: Calls = { common: [], intro: [] };
  const kto = {
    async detailCommon(id: string) {
      calls.common.push(id);
      return over.common === undefined
        ? { title: '오죽헌', firstimage: 'https://x/a.jpg', homepage: '<a href="https://oj.kr">오죽헌</a>' }
        : over.common();
    },
    async detailIntro(id: string) {
      calls.intro.push(id);
      return over.intro === undefined
        ? { restdate: '매주 월요일 휴관', usetime: '09:00~18:00' }
        : over.intro();
    },
  } as unknown as KtoClient;
  return { kto, calls };
}

describe('리포트 원문 재조회', () => {
  it('공식 명칭과 판정 필드 원문을 모은다 (UI-S6-002)', async () => {
    const { kto } = fakeKto();
    const got = (await collectEvidence({ kto, fingerprints: [fp()] })).get('126508');
    expect(got?.officialName).toBe('오죽헌');
    expect(got?.fields).toEqual([
      { name: 'restdate', value: '매주 월요일 휴관' },
      { name: 'usetime', value: '09:00~18:00' },
    ]);
  });

  it('홈페이지가 앵커 태그로 와도 URL 만 싣는다', async () => {
    const { kto } = fakeKto();
    const got = (await collectEvidence({ kto, fingerprints: [fp()] })).get('126508');
    expect(got?.homepageUrl).toBe('https://oj.kr');
  });

  it('🔴 비표출 콘텐츠는 부르지도 않는다 (PM-NG-009)', async () => {
    const { kto, calls } = fakeKto();
    const got = (await collectEvidence({ kto, fingerprints: [fp({ showFlag: 0 })] })).get('126508');

    expect(calls.common).toEqual([]);
    expect(calls.intro).toEqual([]);
    expect(got?.hidden).toBe(true);
    expect(got?.officialName).toBeNull();
    expect(got?.imageUrl).toBeNull();
    expect(got?.fields).toEqual([]);
  });

  it('🔴 한 곳이 실패해도 나머지는 나온다 — 실패는 콘텐츠 단위에 가둔다', async () => {
    let n = 0;
    const kto = {
      async detailCommon(id: string) {
        n += 1;
        if (id === 'bad') throw new ContentNotFoundError('detailCommon2', id);
        return { title: '오죽헌' };
      },
      async detailIntro(id: string) {
        if (id === 'bad') throw new ContentNotFoundError('detailIntro2', id);
        return { restdate: '연중무휴', usetime: '상시' };
      },
    } as unknown as KtoClient;

    const got = await collectEvidence({
      kto,
      fingerprints: [fp(), fp({ ktoContentId: 'bad' })],
    });
    expect(got.get('126508')?.officialName).toBe('오죽헌');
    expect(got.get('bad')?.unavailableReason).toBe('CONTENT_NOT_FOUND');
    expect(n).toBeGreaterThan(0);
  });

  it('명칭만 실패하면 원문 근거는 그대로 싣는다', async () => {
    const { kto } = fakeKto({
      common: () => Promise.reject(new KtoFetchError('detailCommon2', '5xx')),
    });
    const got = (await collectEvidence({ kto, fingerprints: [fp()] })).get('126508');
    expect(got?.officialName).toBeNull();
    expect(got?.fields[0]?.value).toBe('매주 월요일 휴관');
  });

  it('같은 콘텐츠가 여러 항목에 있어도 한 번만 부른다', async () => {
    const { kto, calls } = fakeKto();
    await collectEvidence({ kto, fingerprints: [fp(), fp()] });
    expect(calls.intro).toEqual(['126508']);
  });
});
