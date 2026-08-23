import { describe, expect, it } from 'vitest';
import type { ItineraryItemRow } from './audit-runner';
import { fromSnapshot, snapshotToken, toSnapshot } from './patch-snapshot';

/**
 * 스냅샷과 미리보기 토큰 — 순수 함수라 DB 없이 본다.
 *
 * 되돌리기가 기대는 유일한 근거가 스냅샷이다. 여기서 빠지는 필드는 되돌려도 안 돌아온다.
 */

const AT = new Date('2026-09-15T14:40:12.000Z');

function item(over: Partial<ItineraryItemRow> = {}): ItineraryItemRow {
  return {
    id: 207, dayNo: 1, seq: 1, startTime: '10:00', endTime: '11:30', endTimeSource: 'INPUT',
    placeLabel: '오죽헌', itemType: 'SIGHT', ktoContentId: '126508', contentTypeId: 12,
    lclsSystm1: 'HS', lclsSystm2: 'HS01', lclsSystm3: 'HS010100',
    mapX: 128.877841, mapY: 37.779214, matchStatus: 'CONFIRMED', ...over,
  };
}

describe('일정 스냅샷 (FR-PA-021)', () => {
  it('담았다 꺼내면 일정표가 그대로다 — 되돌리기가 이걸로 복원한다', () => {
    const items = [item(), item({ id: 208, seq: 2, startTime: '12:00', endTime: '13:00', itemType: 'MEAL' })];
    expect(fromSnapshot(toSnapshot(31, items, AT))).toEqual(items);
  });

  it('🔴 항목 id 를 담는다 — 없으면 되돌린 일정을 finding 이 못 가리킨다', () => {
    const snapshot = toSnapshot(31, [item({ id: 207 })], AT);
    expect(snapshot.items[0]?.id).toBe(207);
  });

  it('좌표가 없어도 담긴다 — EXCLUDED 항목은 좌표가 없는 게 정상이다', () => {
    const excluded = item({
      id: 300, ktoContentId: null, contentTypeId: null, mapX: null, mapY: null,
      lclsSystm1: null, lclsSystm2: null, lclsSystm3: null,
      itemType: 'MEAL', matchStatus: 'EXCLUDED', endTime: null,
    });
    expect(fromSnapshot(toSnapshot(31, [excluded], AT))).toEqual([excluded]);
  });

  it('저장 키 이름은 DB 명세서 4-4 를 따른다 — 좌표는 mapx · mapy 다', () => {
    const stored = toSnapshot(31, [item()], AT).items[0];
    expect(stored).toMatchObject({ mapx: 128.877841, mapy: 37.779214 });
    expect(stored).not.toHaveProperty('mapX');
  });
});

describe('미리보기 토큰 (EX-PA-002)', () => {
  it('같은 일정이면 같은 값이다 — 순서가 달라도 마찬가지다', () => {
    const a = item({ id: 1 });
    const b = item({ id: 2, seq: 2, startTime: '12:00' });
    expect(snapshotToken([a, b])).toBe(snapshotToken([b, a]));
  });

  it('일정이 바뀌면 값이 바뀐다 — 확정이 이 차이로 거절한다', () => {
    const base = [item()];
    expect(snapshotToken([item({ startTime: '10:30' })])).not.toBe(snapshotToken(base));
    expect(snapshotToken([item({ dayNo: 2 })])).not.toBe(snapshotToken(base));
    expect(snapshotToken([item({ ktoContentId: '999' })])).not.toBe(snapshotToken(base));
    expect(snapshotToken([...base, item({ id: 208 })])).not.toBe(snapshotToken(base));
  });

  it('🔴 필드 경계를 넘어 붙지 않는다 — 이어 붙이면 다른 일정이 같은 토큰을 갖는다', () => {
    /*
     * 구분자 없이 이으면 `("AB","C")` 와 `("A","BC")` 가 같은 문자열이 된다. 두 일정은
     * 분명히 다른데 확정이 "그대로다" 라고 답하게 된다.
     *
     * **맞닿은 두 필드**로 확인해야 한다. 사이에 다른 값이 끼면 그 값이 구분자 노릇을
     * 해서, 구분자를 빼도 이 검사가 통과한다.
     */
    const left = item({ lclsSystm1: 'AB', lclsSystm2: 'C' });
    const right = item({ lclsSystm1: 'A', lclsSystm2: 'BC' });
    expect(snapshotToken([left])).not.toBe(snapshotToken([right]));
  });

  it('시각을 담지 않는다 — 담으면 매번 달라져 늘 어긋난다', () => {
    expect(snapshotToken([item()])).toBe(snapshotToken([item()]));
  });
});
