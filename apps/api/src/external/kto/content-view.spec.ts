import { describe, expect, it } from 'vitest';
import { KtoFetchError } from './kto.errors';
import type { KtoClient } from './index';
import { fetchContentView } from './content-view';

/**
 * 화면과 리포트가 함께 쓰는 조달기. 저장하지 않는 대신 부를 때마다 옳아야 한다.
 */

interface StubOptions {
  readonly common?: Record<string, unknown> | Error;
  readonly intro?: Record<string, unknown> | Error;
}

function stub(o: StubOptions) {
  const calls: string[] = [];
  const give = (v: Record<string, unknown> | Error | undefined): Record<string, unknown> => {
    if (v instanceof Error) throw v;
    return v ?? {};
  };
  const kto = {
    detailCommon: async (id: string) => { calls.push(`common:${id}`); return give(o.common); },
    detailIntro: async (id: string, t: number) => { calls.push(`intro:${id}:${t}`); return give(o.intro); },
  } as unknown as KtoClient;
  return { kto, calls };
}

const fail = (): KtoFetchError => new KtoFetchError('detailCommon2', 'HTTP 500');

describe('관광지 1건 조달 (FR-AU-013 · 061 · 081)', () => {
  it('판정 필드 원문을 유형별로 담는다', async () => {
    const { kto } = stub({ intro: { restdatefood: '매주 화요일', opentimefood: '10:30~20:00' } });
    const v = await fetchContentView({ kto, ktoContentId: '1', contentTypeId: 39 });
    expect(v.fields).toEqual([
      { name: 'restdatefood', value: '매주 화요일' },
      { name: 'opentimefood', value: '10:30~20:00' },
    ]);
  });

  it('유형을 알면 두 오퍼레이션을 나란히 낸다', async () => {
    const { kto, calls } = stub({});
    await fetchContentView({ kto, ktoContentId: '7', contentTypeId: 12 });
    expect(calls.sort()).toEqual(['common:7', 'intro:7:12']);
  });

  it('유형을 모르면 공통정보로 먼저 알아낸다', async () => {
    const { kto, calls } = stub({ common: { contenttypeid: '38' }, intro: { opentime: '09:00~18:00' } });
    const v = await fetchContentView({ kto, ktoContentId: '9', contentTypeId: null });
    expect(calls).toEqual(['common:9', 'intro:9:38']);
    expect(v.fields.map((f) => f.name)).toEqual(['restdateshopping', 'opentime']);
  });

  describe('문의처 (FR-AU-017)', () => {
    it('소개정보의 infocenter 계열에서 취득한다', async () => {
      const { kto } = stub({ common: { tel: '' }, intro: { infocenterfood: '033-000-0000' } });
      const v = await fetchContentView({ kto, ktoContentId: '1', contentTypeId: 39 });
      expect(v.contact.tel).toBe('033-000-0000');
    });

    it('🔴 tel 이 비고 infocentershopping 에만 있어도 공란이 아니다', async () => {
      // 실측 사례 — 공통정보만 봤다면 "정보 없음" 이 됐을 항목이다
      const { kto } = stub({ common: { tel: '' }, intro: { infocentershopping: '033-648-2285' } });
      const v = await fetchContentView({ kto, ktoContentId: '1', contentTypeId: 38 });
      expect(v.contact.tel).toBe('033-648-2285');
    });

    it('소개정보가 비면 공통정보의 tel 로 넘어간다', async () => {
      const { kto } = stub({ common: { tel: '033-111-2222' }, intro: { infocenter: '' } });
      const v = await fetchContentView({ kto, ktoContentId: '1', contentTypeId: 12 });
      expect(v.contact.tel).toBe('033-111-2222');
    });

    it('둘 다 없으면 null 이다 — 항목을 숨기지 않는다 (FR-AU-082 · EX-PS-010)', async () => {
      const { kto } = stub({ common: {}, intro: {} });
      const v = await fetchContentView({ kto, ktoContentId: '1', contentTypeId: 12 });
      expect(v.contact.tel).toBeNull();
      expect(v.unavailableReason).toBeNull();
    });
  });

  it('비표출은 부르지도 않는다 (PM-NG-009)', async () => {
    const { kto, calls } = stub({ common: { title: '이름이 나오면 안 된다' } });
    const v = await fetchContentView({ kto, ktoContentId: '1', contentTypeId: 12, showFlag: 0 });
    expect(calls).toEqual([]);
    expect(v.hidden).toBe(true);
    expect(v.officialName).toBeNull();
  });

  it('한쪽만 실패하면 얻은 쪽은 싣는다', async () => {
    const { kto } = stub({ common: fail(), intro: { restdate: '연중무휴' } });
    const v = await fetchContentView({ kto, ktoContentId: '1', contentTypeId: 12 });
    expect(v.fields[0]?.value).toBe('연중무휴');
    expect(v.officialName).toBeNull();
  });

  it('둘 다 실패해야 확인 불가로 적는다', async () => {
    const { kto } = stub({ common: fail(), intro: fail() });
    const v = await fetchContentView({ kto, ktoContentId: '1', contentTypeId: 12 });
    expect(v.unavailableReason).not.toBeNull();
    expect(v.fields).toEqual([]);
  });

  it('홈페이지는 앵커에서 링크만 뽑는다', async () => {
    const { kto } = stub({ common: { homepage: '<a href="https://oj.kr" target="_blank">오죽헌</a>' } });
    const v = await fetchContentView({ kto, ktoContentId: '1', contentTypeId: 12 });
    expect(v.homepageUrl).toBe('https://oj.kr');
  });
});
