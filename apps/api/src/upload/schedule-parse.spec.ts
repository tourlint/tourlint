import { describe, expect, it } from 'vitest';
import { parseSchedule } from './schedule-parse';

// 지정 양식 배치를 그대로 흉내 낸다 — 위 3줄은 안내, 5행이 헤더, 그 아래가 데이터.
const HEADER = ['일차', '시작시간', '종료시간', '장소명', '유형'];
function sheet(dataRows: (string | null)[][]): (string | null)[][] {
  return [['안내'], ['유형 안내'], ['설명'], [], HEADER, ...dataRows];
}

describe('parseSchedule', () => {
  it('정상 양식을 일차·항목으로 구조화한다 (종료시간 공란 허용)', () => {
    const r = parseSchedule(
      sheet([
        ['1', '10:00', '11:30', '오죽헌', '관광'],
        ['1', '12:00', '13:00', '소나무집초당순두부', '식사'],
        ['1', '21:00', null, '세인트존스호텔', '숙박'], // 종료 공란
        ['2', '09:30', '11:00', '경포대', '관광'],
      ]),
    );
    expect(r.rejected).toBeUndefined();
    expect(r.errors).toEqual([]);
    expect(r.nights).toBe(1); // 최대 2일차 → 1박
    expect(r.items).toEqual([
      { day: 1, start: '10:00', end: '11:30', place: '오죽헌', itemType: 'SIGHT' },
      { day: 1, start: '12:00', end: '13:00', place: '소나무집초당순두부', itemType: 'MEAL' },
      { day: 1, start: '21:00', end: null, place: '세인트존스호텔', itemType: 'LODGING' },
      { day: 2, start: '09:30', end: '11:00', place: '경포대', itemType: 'SIGHT' },
    ]);
  });

  it('4일차가 있으면 파일 전체를 거부한다 (DAY_COUNT_MISMATCH)', () => {
    const r = parseSchedule(
      sheet([
        ['1', '10:00', '11:30', '오죽헌', '관광'],
        ['4', '10:00', '11:30', '어딘가', '관광'],
      ]),
    );
    expect(r.rejected?.code).toBe('DAY_COUNT_MISMATCH');
    expect(r.items).toEqual([]);
  });

  it('실패한 행은 번호와 사유로 남기고 정상 행은 유지한다 (FR-IN-015)', () => {
    const r = parseSchedule(
      sheet([
        ['1', '10:00', '11:30', '오죽헌', '관광'], // 행6 정상
        ['1', '25:00', '11:30', '잘못된시간', '관광'], // 행7 시간 오류
        ['1', '12:00', '13:00', '', '식사'], // 행8 장소 누락
        ['1', '14:00', '15:00', '분류틀림', '드라이브'], // 행9 유형 오류
      ]),
    );
    expect(r.rejected).toBeUndefined();
    expect(r.items).toHaveLength(1);
    expect(r.errors.map((e) => e.row)).toEqual([7, 8, 9]);
    const reasons = r.errors.map((e) => e.reason).join(' | ');
    expect(reasons).toContain('시작시간');
    expect(reasons).toContain('장소명');
    expect(reasons).toContain('유형');
  });

  it('헤더가 없으면 양식 불일치로 거부한다', () => {
    const r = parseSchedule([['아무거나'], ['1', '10:00', '', 'x', '관광']]);
    expect(r.rejected?.code).toBe('TEMPLATE_MISMATCH');
  });

  it('필수 컬럼이 빠지면 어느 컬럼인지 짚어 거부한다 (EX-IN-001)', () => {
    // 장소명 컬럼이 없는 헤더
    const r = parseSchedule([
      ['안내'],
      [],
      ['일차', '시작시간', '종료시간', '유형'],
      ['1', '10:00', '11:30', '관광'],
    ]);
    expect(r.rejected?.code).toBe('TEMPLATE_MISMATCH');
    expect(r.rejected?.message).toContain('장소명');
  });

  it('행이 500개를 넘으면 파싱 전에 거부한다 (EX-IN-003)', () => {
    const many = Array.from({ length: 501 }, () => ['1', '10:00', '11:30', 'x', '관광']);
    const r = parseSchedule(sheet(many));
    expect(r.rejected?.code).toBe('UPLOAD_LIMIT_EXCEEDED');
    expect(r.items).toEqual([]);
  });

  it('유효 항목이 45건을 넘으면 거부한다 (EX-IN-004)', () => {
    const items = Array.from({ length: 46 }, () => ['1', '10:00', '11:30', 'x', '관광']);
    const r = parseSchedule(sheet(items));
    expect(r.rejected?.code).toBe('UPLOAD_LIMIT_EXCEEDED');
    expect(r.rejected?.message).toContain('45');
  });
});
