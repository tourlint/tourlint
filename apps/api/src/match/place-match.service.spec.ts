import { describe, expect, it } from 'vitest';
import type { KtoClient } from '../external/kto';
import type { PlaceMatchRepository } from './place-match.repository';
import { PlaceMatchService, copyrightNote } from './place-match.service';

/** 확정 응답의 출처 배지 (FR-CM-011 · EI-KT-017). 저장 경로는 `place-match.repository.spec` 이 덮는다 */
function service(common: Record<string, unknown>) {
  const repo = {
    findItem: async () => ({ itemId: 101, productId: 1, ldongRegnCd: '51', ldongSignguCd: '150', placeLabel: '오죽헌' }),
    confirm: async () => undefined,
  } as unknown as PlaceMatchRepository;
  const kto = { detailCommon: async () => ({ contenttypeid: '14', mapx: '128.87', mapy: '37.77', ...common }) } as unknown as KtoClient;
  return new PlaceMatchService(repo, () => kto);
}

describe('장소 확정 응답의 출처 배지', () => {
  it('🔴 받은 저작권 유형대로 적는다 — Type3 만 변경금지, Type1 에는 붙이지 않는다', async () => {
    const type3 = await service({ cpyrhtDivCd: 'Type3' }).match(7, 101, '2868839');
    expect(type3.sourceBadge).toEqual({ type: 'KTO_RAW', note: '변경금지' });
    // 오죽헌(129784)은 실측 Type1 이다. 종전에는 여기에도 변경금지가 나갔다
    const type1 = await service({ cpyrhtDivCd: 'Type1' }).match(7, 101, '129784');
    expect(type1.sourceBadge).toEqual({ type: 'KTO_RAW', note: null });
    expect((type1.content as { cpyrhtDivCd: string | null }).cpyrhtDivCd).toBe('Type1');
  });

  it('값이 없으면 표기를 생략한다', async () => {
    const blank = await service({ cpyrhtDivCd: '' }).match(7, 101, '2941250');
    expect(blank.sourceBadge).toEqual({ type: 'KTO_RAW', note: null });
    expect(copyrightNote(null)).toBeNull();
  });
});
