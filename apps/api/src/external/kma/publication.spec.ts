import { describe, expect, it } from 'vitest';
import {
  MID_OFFSET_RANGE, PUBLISH_MARGIN_MINUTES, chooseMidPublication, chooseShortPublication,
  daysBetween, kstToday, midTargetDate,
} from './publication';

/** 한국 시간 문자열을 Date 로. 테스트가 서버 시간대에 흔들리지 않게 한다 */
function kst(iso: string): Date {
  return new Date(`${iso}+09:00`);
}

describe('발표분 고르기 (EI-WX-003 · 008)', () => {
  describe('단기예보', () => {
    it('발표 + 여유가 지난 가장 최신 발표분을 고른다', () => {
      expect(chooseShortPublication(kst('2026-08-26T17:22:00'))).toEqual({
        baseDate: '20260826', baseTime: '1400',
      });
    });

    it('여유가 지나면 그 발표분으로 넘어간다', () => {
      expect(chooseShortPublication(kst('2026-08-26T17:46:00')).baseTime).toBe('1700');
    });

    it('02:45 이전은 어제 2300 발표분이다', () => {
      expect(chooseShortPublication(kst('2026-08-26T01:10:00'))).toEqual({
        baseDate: '20260825', baseTime: '2300',
      });
    });

    it('자정 직후에도 날짜가 어제로 넘어간다', () => {
      expect(chooseShortPublication(kst('2026-08-26T00:05:00'))).toEqual({
        baseDate: '20260825', baseTime: '2300',
      });
    });

    it('🔴 UTC 로 계산하면 한국 시간 오후 9시 이후가 하루 밀린다', () => {
      // 한국 2026-08-26 21:30 = UTC 12:30. 서버 시계를 그대로 읽으면 1100 발표분을 고른다
      expect(chooseShortPublication(kst('2026-08-26T21:30:00'))).toEqual({
        baseDate: '20260826', baseTime: '2000',
      });
    });
  });

  describe('중기육상예보', () => {
    it('06시 발표는 D+4 를 덮는다', () => {
      const p = chooseMidPublication(kst('2026-08-26T10:00:00'), '2026-08-30');
      expect(p).toEqual({ tmFc: '202608260600', baseDate: '2026-08-26', hour: 6 });
    });

    it('🔴 저녁에도 D+4 는 06시 발표분으로 간다 — 18시 발표에는 rnSt4 가 없다', () => {
      const p = chooseMidPublication(kst('2026-08-26T20:00:00'), '2026-08-30');
      expect(p?.hour).toBe(6);
      expect(p?.tmFc).toBe('202608260600');
    });

    it('D+5 이후는 저녁이면 최신 18시 발표분을 쓴다', () => {
      const p = chooseMidPublication(kst('2026-08-26T20:00:00'), '2026-08-31');
      expect(p).toEqual({ tmFc: '202608261800', baseDate: '2026-08-26', hour: 18 });
    });

    it('06시 발표 전에는 어제 18시 발표분이 D+4 를 덮는다', () => {
      const p = chooseMidPublication(kst('2026-08-26T03:00:00'), '2026-08-30');
      expect(p).toEqual({ tmFc: '202608251800', baseDate: '2026-08-25', hour: 18 });
      // 어제 18시 기준으로 08-30 은 +5 다
      expect(daysBetween('2026-08-25', '2026-08-30')).toBe(5);
    });

    it('06시 발표 전 D+10 은 어느 발표분도 못 덮는다', () => {
      expect(chooseMidPublication(kst('2026-08-26T03:00:00'), '2026-09-05')).toBeNull();
    });

    it('D+11 이상은 중기 범위 밖이다 — 평년 테이블로 간다', () => {
      expect(chooseMidPublication(kst('2026-08-26T10:00:00'), '2026-09-06')).toBeNull();
    });

    it('D+3 이하도 중기가 아니다', () => {
      expect(chooseMidPublication(kst('2026-08-26T10:00:00'), '2026-08-29')).toBeNull();
    });

    it('발표 직후 여유 안에는 아직 이전 발표분이다', () => {
      const justAfter = kst('2026-08-26T18:10:00');
      expect(PUBLISH_MARGIN_MINUTES).toBeGreaterThan(10);
      expect(chooseMidPublication(justAfter, '2026-08-31')?.hour).toBe(6);
    });

    it('오프셋이 가리키는 날짜', () => {
      const p = { tmFc: '202608260600', baseDate: '2026-08-26', hour: 6 } as const;
      expect(midTargetDate(p, 4)).toBe('2026-08-30');
      expect(midTargetDate(p, 10)).toBe('2026-09-05');
    });

    it('발표 시각별 오프셋 범위 — 06시 +4, 18시 +5 (2026.08.26 실측)', () => {
      expect(MID_OFFSET_RANGE[6]).toEqual({ from: 4, to: 10 });
      expect(MID_OFFSET_RANGE[18]).toEqual({ from: 5, to: 10 });
    });
  });

  it('날짜 차이를 못 읽으면 0 이 아니라 null 이다', () => {
    expect(daysBetween('2026-08-26', '2026-08-26')).toBe(0);
    expect(daysBetween('그저께', '2026-08-26')).toBeNull();
  });

  it('한국 시간 기준 오늘', () => {
    expect(kstToday(new Date('2026-08-26T15:30:00Z'))).toBe('2026-08-27');
  });
});
