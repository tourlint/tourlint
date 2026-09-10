import { describe, expect, it } from 'vitest';
import { NL_SCHEMA, NL_SYSTEM, toParseResult } from './nl-parse';

/**
 * 자연어 정형화의 **결정론적 절반** (FR-IN-003).
 *
 * LLM 출력을 받아 저장 전 편집용 결과로 만드는 부분은 모델 없이 검증할 수 있다.
 * 모델이 실제로 저 모양을 주는지는 `test/live-llm.smoke.spec.ts` 가 `LIVE_LLM=1` 로 본다.
 */

/** 명세 AC 의 문장을 모델이 옮겼을 때 나올 모양 (13_기능요구사항 484행) */
const AC_OUTPUT = {
  items: [
    { day: 1, start: '10:00', end: null, place: '오죽헌', type: '관광' },
    { day: 1, start: '12:00', end: null, place: '중앙시장', type: '식사' },
    { day: 1, start: '14:00', end: null, place: '안목해변', type: '관광' },
    { day: 1, start: '18:00', end: null, place: '식사', type: '식사' },
    { day: 1, start: '20:00', end: null, place: '숙소', type: '숙박' },
  ],
};

describe('자연어 정형화 (FR-IN-003)', () => {
  it('AC 문장이 5개 항목으로 나온다 — 일차 · 시각 · 유형과 함께', () => {
    const out = toParseResult(AC_OUTPUT);

    expect(out.rejected).toBeUndefined();
    expect(out.items).toHaveLength(5);
    expect(out.nights).toBe(0);
    expect(out.items.map((i) => i.itemType)).toEqual(['SIGHT', 'MEAL', 'SIGHT', 'MEAL', 'LODGING']);
    expect(out.items.map((i) => i.start)).toEqual(['10:00', '12:00', '14:00', '18:00', '20:00']);
  });

  it('종료 시각이 없으면 null 로 둔다 — 지어내지 않는다 (FR-IN-011)', () => {
    const out = toParseResult(AC_OUTPUT);
    expect(out.items.every((i) => i.end === null)).toBe(true);
  });

  it('일차가 섞여 오면 일차 · 시각 순으로 세운다', () => {
    const out = toParseResult({
      items: [
        { day: 2, start: '09:00', place: '경포대', type: '관광' },
        { day: 1, start: '18:00', place: '저녁', type: '식사' },
        { day: 1, start: '10:00', place: '오죽헌', type: '관광' },
      ],
    });
    expect(out.items.map((i) => `${String(i.day)} ${i.start}`)).toEqual(['1 10:00', '1 18:00', '2 09:00']);
    expect(out.nights).toBe(1);
  });

  it('읽지 못한 항목은 버리되 몇 번째인지와 사유를 남긴다 (FR-IN-015)', () => {
    const out = toParseResult({
      items: [
        { day: 1, start: '10:00', place: '오죽헌', type: '관광' },
        { day: 1, start: '25:00', place: '잘못된 시각', type: '관광' },
        { day: 9, start: '11:00', place: '범위 밖 일차', type: '관광' },
        { day: 1, start: '12:00', place: '', type: '식사' },
        { day: 1, start: '13:00', place: '모르는 유형', type: '체험' },
      ],
    });

    expect(out.items).toHaveLength(1);
    expect(out.errors.map((e) => e.row)).toEqual([2, 3, 4, 5]);
    expect(out.errors[0]?.reason).toContain('시작 시각');
    expect(out.errors[1]?.reason).toContain('일차');
    expect(out.errors[2]?.reason).toContain('장소명');
    expect(out.errors[3]?.reason).toContain('유형');
  });

  it('하나도 못 건지면 거부한다 — 빈 상품을 만들지 않는다 (EX-IN-010)', () => {
    const out = toParseResult({ items: [{ day: 1, start: '99:99', place: 'x', type: '관광' }] });
    expect(out.rejected?.code).toBe('NL_STRUCTURE_FAILED');
    expect(out.items).toHaveLength(0);
  });

  it('일정이 아닌 것을 넣으면 거부한다', () => {
    expect(toParseResult({}).rejected?.code).toBe('NL_STRUCTURE_FAILED');
    expect(toParseResult(null).rejected?.code).toBe('NL_STRUCTURE_FAILED');
    expect(toParseResult({ items: '오죽헌' }).rejected?.code).toBe('NL_STRUCTURE_FAILED');
  });

  it('항목 상한을 넘으면 거부한다 (NF-CP-003)', () => {
    const many = Array.from({ length: 46 }, (_, i) => ({
      day: 1, start: '10:00', place: `장소${String(i)}`, type: '관광',
    }));
    expect(toParseResult({ items: many }).rejected?.code).toBe('UPLOAD_LIMIT_EXCEEDED');
  });

  it('지시에 계정 정보나 타 상품 데이터를 담지 않는다 (EI-LM-004)', () => {
    expect(NL_SYSTEM).not.toMatch(/api[_-]?key|token|비밀번호|account/i);
    // 없는 값을 지어내지 말라는 지시가 빠지면 모델이 시각을 채운다
    expect(NL_SYSTEM).toContain('지어내지 않는다');
  });

  it('스키마가 유형 6종만 허용한다', () => {
    const items = (NL_SCHEMA.properties.items as { items: { properties: { type: { enum: string[] } } } });
    expect(items.items.properties.type.enum).toEqual(['관광', '식사', '숙박', '휴식', '이동', '자유']);
  });
});
