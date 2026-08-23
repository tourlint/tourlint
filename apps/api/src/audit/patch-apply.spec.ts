import { describe, expect, it } from 'vitest';
import type { ItineraryItemRow } from './audit-runner';
import { applyPatches, orderPatches } from './patch-apply';
import { checkConflicts, orderDependentConflicts } from './patch-conflict';
import { selectionKey, type SelectedPatch } from './patch-types';

const item = (over: Partial<ItineraryItemRow> & Pick<ItineraryItemRow, 'id' | 'seq'>): ItineraryItemRow => ({
  dayNo: 1, startTime: '10:00', endTime: '11:00', endTimeSource: 'INPUT',
  placeLabel: `장소${over.id}`, itemType: 'SIGHT', ktoContentId: null, contentTypeId: null,
  lclsSystm1: null, lclsSystm2: null, lclsSystm3: null, mapX: null, mapY: null,
  matchStatus: 'CONFIRMED', ...over,
});

const DAY: readonly ItineraryItemRow[] = [
  item({ id: 1, seq: 1, startTime: '09:00', endTime: '10:00' }),
  item({ id: 2, seq: 2, startTime: '11:00', endTime: '12:00' }),
  item({ id: 3, seq: 3, startTime: '14:00', endTime: '15:00' }),
];

/** 테스트에서는 finding 하나에 수정안 하나씩 붙은 것으로 본다 */
let nextFinding = 900;
const shift = (id: string, target: number, over: Record<string, unknown>): SelectedPatch =>
  ({ findingId: nextFinding++, patchId: id, type: 'TIME_SHIFT', targetItemId: target, payload: over }) as SelectedPatch;
const remove = (id: string, target: number): SelectedPatch =>
  ({ findingId: nextFinding++, patchId: id, type: 'REMOVE_ITEM', targetItemId: target, payload: {} }) as SelectedPatch;
const reorder = (id: string, target: number, other: number): SelectedPatch =>
  ({ findingId: nextFinding++, patchId: id, type: 'REORDER', targetItemId: target, payload: { swapWithItemId: other } }) as SelectedPatch;
const insert = (id: string, day: number, start: string, end: string): SelectedPatch =>
  ({
    findingId: nextFinding++, patchId: id, type: 'INSERT_ITEM', targetItemId: 0,
    payload: { dayNo: day, afterItemId: null, startTime: start, endTime: end, itemType: 'MEAL' },
  }) as SelectedPatch;

describe('반영 순서 (FR-PA-020)', () => {
  it('빼기 → 대체 → 이동 → 교체 → 넣기 순이다', () => {
    const order = orderPatches([
      insert('p-5', 1, '12:00', '13:00'),
      shift('p-3', 1, { newStartTime: '08:00' }),
      remove('p-1', 3),
      reorder('p-4', 1, 2),
    ]).map((p) => p.type);
    expect(order).toEqual(['REMOVE_ITEM', 'TIME_SHIFT', 'REORDER', 'INSERT_ITEM']);
  });

  it('입력 순서가 달라도 결과가 같다', () => {
    const patches = [shift('p-1', 1, { newStartTime: '08:00' }), remove('p-2', 3)];
    const a = applyPatches(DAY, patches).items;
    const b = applyPatches(DAY, [...patches].reverse()).items;
    expect(a).toEqual(b);
  });
});

describe('반영', () => {
  it('시각을 옮기면 종료시간 출처가 입력으로 바뀐다 (FR-RU-031)', () => {
    const boosted = [item({ id: 1, seq: 1, endTimeSource: 'DWELL_DEFAULT' })];
    const [out] = applyPatches(boosted, [shift('p-1', 1, { newStartTime: '13:00', newEndTime: '14:00' })]).items;
    expect(out).toMatchObject({ startTime: '13:00', endTime: '14:00', endTimeSource: 'INPUT' });
  });

  it('시각을 안 건드리면 출처도 그대로다', () => {
    const boosted = [item({ id: 1, seq: 1, endTimeSource: 'DWELL_DEFAULT' })];
    const [out] = applyPatches(boosted, [shift('p-1', 1, { newDayNo: 2 })]).items;
    expect(out).toMatchObject({ dayNo: 2, endTimeSource: 'DWELL_DEFAULT' });
  });

  it('교체는 순서와 시각을 함께 바꾼다 — seq 만 바꾸면 화면에서 어긋난다', () => {
    const out = applyPatches(DAY, [reorder('p-1', 1, 3)]).items;
    const one = out.find((i) => i.id === 1);
    const three = out.find((i) => i.id === 3);
    expect(one).toMatchObject({ startTime: '14:00', endTime: '15:00' });
    expect(three).toMatchObject({ startTime: '09:00', endTime: '10:00' });
  });

  it('대체는 명칭을 건드리지 않는다 — 대체 관광지 이름은 공사 원문이다 (DR-PR-001)', () => {
    const patch = {
      patchId: 'p-1', type: 'REPLACE_CONTENT', targetItemId: 1,
      findingId: 901,
      payload: { ktoContentId: '126508', contentTypeId: 12, lclsSystm2: 'AC01', mapx: 128.8, mapy: 37.7, distanceMeters: 1200, parseConfidence: 'CONFIRMED' },
    } as SelectedPatch;
    const out = applyPatches(DAY, [patch]).items.find((i) => i.id === 1);
    expect(out?.ktoContentId).toBe('126508');
    expect(out?.placeLabel).toBe('장소1');
    expect(JSON.stringify(out)).not.toContain('선교장');
  });

  it('대상이 이미 없으면 조용히 삼키지 않는다', () => {
    const patch = shift('p-1', 99, { newStartTime: '08:00' });
    const out = applyPatches(DAY, [patch]);
    expect(out.applied).toEqual([]);
    expect(out.skipped).toEqual([{ patchId: selectionKey(patch), reason: '대상 일정이 이미 없습니다' }]);
  });

  it('반영 후 seq 를 시각 순으로 다시 매긴다 — 규칙들이 이 순서를 전제한다', () => {
    const out = applyPatches(DAY, [shift('p-1', 3, { newStartTime: '08:00', newEndTime: '08:30' })]).items;
    expect(out.map((i) => [i.id, i.seq])).toEqual([[3, 1], [1, 2], [2, 3]]);
  });

  it('넣은 항목은 임시 id 를 받고 매칭 대상에서 빠진다', () => {
    /*
     * `EXCLUDED` 다. 식사·휴식은 공사에 물어볼 것이 없어 매칭을 기다리는 상태가 아니다 —
     * `PENDING` 으로 두면 확정 뒤 R05 가 이름도 없는 항목을 확인 불가로 세고, 다음
     * 사용자 검수가 `PLACE_UNRESOLVED` 로 거절당한다 (EX-AU-001 · FR-PA-022).
     */
    const out = applyPatches(DAY, [insert('p-1', 1, '12:00', '13:00')]).items;
    const added = out.find((i) => i.id < 0);
    expect(added).toMatchObject({ itemType: 'MEAL', matchStatus: 'EXCLUDED', placeLabel: '' });
    // EXCLUDED 는 contentid 가 없어야 한다 (`ck_item_match_content`)
    expect(added?.ktoContentId).toBeNull();
  });

  it('넣은 항목의 임시 id 가 반영 순서에 흔들리지 않는다', () => {
    const patches = [insert('p-1', 1, '12:00', '12:30'), insert('p-2', 1, '16:00', '16:30')];
    const forward = applyPatches(DAY, patches, { preserveOrder: true }).items.filter((i) => i.id < 0);
    const backward = applyPatches(DAY, [...patches].reverse(), { preserveOrder: true }).items.filter((i) => i.id < 0);
    expect(forward.map((i) => [i.id, i.startTime])).toEqual(backward.map((i) => [i.id, i.startTime]));
  });
});

describe('충돌 검사 (FR-PA-005 ~ 007)', () => {
  it('충돌이 없으면 없다고 말한다 (FR-PA-007)', () => {
    const r = checkConflicts(DAY, [shift('p-1', 1, { newStartTime: '08:00', newEndTime: '08:30' })]);
    expect(r).toEqual({ hasConflict: false, conflicts: [] });
  });

  it('① 같은 항목을 둘이 건드리면 충돌이다', () => {
    const r = checkConflicts(DAY, [
      shift('p-1', 2, { newStartTime: '13:00' }),
      remove('p-2', 2),
    ]);
    expect(r.hasConflict).toBe(true);
    expect(r.conflicts[0]?.kind).toBe('SAME_ITEM');
    expect([r.conflicts[0]?.a.patchId, r.conflicts[0]?.b.patchId]).toEqual(['p-1', 'p-2']);
  });

  it('교체는 상대 항목까지 건드린 것으로 본다 — 대상만 보면 놓친다', () => {
    const r = checkConflicts(DAY, [reorder('p-1', 1, 2), shift('p-2', 2, { newStartTime: '13:00' })]);
    expect(r.conflicts[0]?.kind).toBe('SAME_ITEM');
  });

  it('② 함께 반영하면 새로 겹치는 경우 충돌이다', () => {
    const r = checkConflicts(DAY, [
      shift('p-1', 1, { newStartTime: '14:00', newEndTime: '15:00' }),
      shift('p-2', 2, { newStartTime: '14:30', newEndTime: '15:30' }),
    ]);
    expect(r.hasConflict).toBe(true);
    expect(r.conflicts.some((c) => c.kind === 'TIME_OVERLAP')).toBe(true);
  });

  it('원래 겹쳐 있던 쌍은 수정안 충돌이 아니다 — R03 이 이미 지적한다', () => {
    const overlapping = [
      item({ id: 1, seq: 1, startTime: '10:00', endTime: '12:00' }),
      item({ id: 2, seq: 2, startTime: '11:00', endTime: '13:00' }),
      item({ id: 3, seq: 3, startTime: '15:00', endTime: '16:00' }),
    ];
    const r = checkConflicts(overlapping, [
      shift('p-1', 3, { newStartTime: '17:00', newEndTime: '18:00' }),
      shift('p-2', 3, { newStartTime: '18:00', newEndTime: '19:00' }),
    ]);
    expect(r.conflicts.every((c) => c.kind !== 'TIME_OVERLAP')).toBe(true);
  });

  it('③ 순서에 따라 결과가 달라지는 쌍을 짚는다', () => {
    /*
     * 빼기를 먼저 하면 교체 상대가 사라져 건너뛴다. 교체를 먼저 하면 자리를 맞바꾼 뒤
     * 빠진다 — 남는 항목의 시각이 달라진다.
     *
     * `checkConflicts` 로 보면 ① 이 먼저 잡아 이 검사가 죽어 있어도 통과한다. 실제로
     * 한동안 죽어 있었다 — `applyPatches` 가 내부에서 다시 정렬해 뒤집어 넣어도 같은
     * 순서로 돌았다. 그래서 검사를 직접 부른다.
     */
    const found = orderDependentConflicts(DAY, [remove('p-1', 2), reorder('p-2', 1, 2)]);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('ORDER_DEPENDENT');
    expect([found[0]?.a.patchId, found[0]?.b.patchId]).toEqual(['p-1', 'p-2']);
  });

  it('순서와 무관한 쌍은 짚지 않는다', () => {
    const found = orderDependentConflicts(DAY, [
      shift('p-1', 1, { newStartTime: '08:00', newEndTime: '08:30' }),
      shift('p-2', 3, { newStartTime: '16:00', newEndTime: '17:00' }),
    ]);
    expect(found).toEqual([]);
  });

  it('셋 이상이어도 문제되는 쌍만 짚는다 — 전체를 뒤집으면 누가 문제인지 못 짚는다', () => {
    const found = orderDependentConflicts(DAY, [
      shift('p-0', 1, { newStartTime: '08:00', newEndTime: '08:30' }),
      remove('p-1', 2),
      reorder('p-2', 3, 2),
    ]);
    expect(found.map((c) => [c.a.patchId, c.b.patchId])).toEqual([['p-1', 'p-2']]);
  });

  it('같은 쌍이 여러 이유로 걸려도 한 번만 말한다', () => {
    const r = checkConflicts(DAY, [shift('p-1', 2, { newStartTime: '09:30' }), remove('p-2', 2)]);
    const keys = r.conflicts.map((c) => `${selectionKey(c.a)}|${selectionKey(c.b)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('충돌해도 수정안을 스스로 해제하지 않는다 (FR-PA-006)', () => {
    // 보고만 하고 목록은 그대로다. 어느 쪽을 살릴지는 사용자만 안다
    const patches = [shift('p-1', 2, { newStartTime: '13:00' }), remove('p-2', 2)];
    const before = JSON.stringify(patches);
    checkConflicts(DAY, patches);
    expect(JSON.stringify(patches)).toBe(before);
  });

  it('수정안이 하나뿐이면 충돌이 있을 수 없다', () => {
    expect(checkConflicts(DAY, [remove('p-1', 1)]).hasConflict).toBe(false);
  });

  it('같은 입력에 같은 결과다 (NF-MT-001)', () => {
    const patches = [shift('p-1', 1, { newStartTime: '14:00', newEndTime: '15:00' }), remove('p-2', 3)];
    expect(JSON.stringify(checkConflicts(DAY, patches))).toBe(JSON.stringify(checkConflicts(DAY, patches)));
  });
});

describe('수정안 식별 (patchId 는 finding 안에서만 유일하다)', () => {
  it('다른 finding 의 같은 patchId 를 같은 것으로 보지 않는다', () => {
    /*
     * 규칙마다 수정안에 `p-1` · `p-2` 를 붙인다. finding 을 빼고 `p-1` 만 보면 서로 다른
     * 두 수정안이 같은 것으로 취급되고, 반영 결과에서 하나가 사라진다.
     */
    const a: SelectedPatch = { findingId: 11, patchId: 'p-1', type: 'REMOVE_ITEM', targetItemId: 1, payload: {} };
    const b: SelectedPatch = { findingId: 22, patchId: 'p-1', type: 'REMOVE_ITEM', targetItemId: 3, payload: {} };
    const out = applyPatches(DAY, [a, b]);
    expect(out.applied).toEqual(['11:p-1', '22:p-1']);
    expect(out.items.map((i) => i.id)).toEqual([2]);
  });

  it('충돌 쌍도 finding 과 함께 알린다 (FR-PA-006)', () => {
    const a: SelectedPatch = { findingId: 11, patchId: 'p-1', type: 'REMOVE_ITEM', targetItemId: 1, payload: {} };
    const b: SelectedPatch = { findingId: 22, patchId: 'p-1', type: 'REMOVE_ITEM', targetItemId: 1, payload: {} };
    const [c] = checkConflicts(DAY, [a, b]).conflicts;
    expect(c?.a).toEqual({ findingId: 11, patchId: 'p-1' });
    expect(c?.b).toEqual({ findingId: 22, patchId: 'p-1' });
  });
});
