import { describe, expect, it } from 'vitest';
import type { KtoClient } from '../external/kto';
import { ContentService } from './content.service';

/** 응답 계약만 본다 — 조달 로직은 `content-view.spec` 이 덮는다 */
function service(intro: Record<string, unknown>, common: Record<string, unknown> = {}) {
  const seen: number[] = [];
  const kto = {
    detailCommon: async () => common,
    detailIntro: async (_id: string, t: number) => { seen.push(t); return intro; },
  } as unknown as KtoClient;
  return { svc: new ContentService(() => kto), seen };
}

describe('ContentService (API 설계 4-2 · 5-12)', () => {
  it('판정 필드를 ktoRaw 로 그대로 준다', async () => {
    const { svc } = service({ restdatefood: '매주 화요일', opentimefood: '10:30~20:00' });
    const body = await svc.detail('2868839', '39');
    expect(body.ktoRaw).toEqual({ restdatefood: '매주 화요일', opentimefood: '10:30~20:00' });
    expect(body.contentId).toBe('2868839');
    expect(typeof body.fetchedAt).toBe('string');
  });

  it('유형을 주면 그 유형으로 소개정보를 부른다', async () => {
    const { svc, seen } = service({});
    await svc.detail('1', '38');
    expect(seen).toEqual([38]);
  });

  it('아는 유형이 아니면 공통정보로 알아낸다', async () => {
    const { svc, seen } = service({}, { contenttypeid: '14' });
    await svc.detail('1', '99');
    expect(seen).toEqual([14]);
  });

  it('🔴 저작권 유형(cpyrhtDivCd)을 싣는다 — 화면이 Type3 에 「변경금지」를 붙인다 (FR-CM-011 · EI-KT-017)', async () => {
    expect((await service({}, { cpyrhtDivCd: 'Type3' }).svc.detail('2868839', '39')).cpyrhtDivCd).toBe('Type3');
    expect((await service({}, { cpyrhtDivCd: 'Type1' }).svc.detail('129784', '14')).cpyrhtDivCd).toBe('Type1');
    // 실측에 빈 값도 있다(감자유원지 등). 없으면 null — 지어내지 않는다
    expect((await service({}, { cpyrhtDivCd: '' }).svc.detail('2941250', '12')).cpyrhtDivCd).toBeNull();
  });
});

describe('카드 펼침의 조건 축 (FR-PL-012 · API 4-10)', () => {
  const conditions = (found: { accessible: Record<string, unknown> | null; pet: Record<string, unknown> | null }) => {
    const asked: unknown[] = [];
    return {
      asked,
      service: {
        of: async (contentId: string, want: unknown) => { asked.push({ contentId, want }); return found; },
      } as unknown as import('../plan/place-conditions.service').PlaceConditionService,
    };
  };

  it('🔴 with 를 주지 않으면 조건 축을 부르지도 싣지도 않는다 — 검수 화면의 콜 수가 그대로다', async () => {
    const found = conditions({ accessible: { wheelchair: '있음' }, pet: null });
    const body = await new ContentService(() => ({
      detailCommon: async () => ({}),
      detailIntro: async () => ({}),
    } as unknown as KtoClient), found.service).detail('129784', '12');

    expect(body).not.toHaveProperty('accessible');
    expect(body).not.toHaveProperty('pet');
    expect(found.asked).toEqual([]);
  });

  it('요청한 축만 싣는다', async () => {
    const found = conditions({ accessible: { wheelchair: '있음' }, pet: null });
    const body = await new ContentService(() => ({
      detailCommon: async () => ({}),
      detailIntro: async () => ({}),
    } as unknown as KtoClient), found.service).detail('129784', '12', { accessible: true, pet: false });

    expect(body.accessible).toEqual({ wheelchair: '있음' });
    expect(body).not.toHaveProperty('pet');
    expect(found.asked).toEqual([{ contentId: '129784', want: { accessible: true, pet: false } }]);
  });

  it('🔴 조건 축을 못 받아도 카드의 나머지는 그대로다 (EX-PL-004)', async () => {
    const found = conditions({ accessible: null, pet: null });
    const body = await new ContentService(() => ({
      detailCommon: async () => ({}),
      detailIntro: async () => ({ usetime: '09:00~18:00' }),
    } as unknown as KtoClient), found.service).detail('129784', '12', { accessible: true, pet: true });

    expect(body.accessible).toBeNull();
    expect(body.pet).toBeNull();
    expect(body.ktoRaw).toMatchObject({ usetime: '09:00~18:00' });
  });
});

