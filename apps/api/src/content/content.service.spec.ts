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
});
