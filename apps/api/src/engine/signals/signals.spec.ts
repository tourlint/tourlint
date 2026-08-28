import { describe, expect, it } from 'vitest';
import {
  T1_DEFAULT_DAYS, T2_MARGIN_DAYS,
  summarizeFestivals, summarizeNewContents, t1Window, t2Window,
  type SignalContent, type SignalWindow,
} from './index';

const content = (over: Partial<SignalContent> = {}): SignalContent => ({
  contentId: '1', contentTypeId: '12', ldongRegnCd: '51', ldongSignguCd: '150',
  createdTime: '20260820103000', eventStart: null, eventEnd: null, matchesKeyword: false,
  ...over,
});

const window = (over: Partial<SignalWindow> = {}): SignalWindow => ({
  ldongRegnCd: '51', ldongSignguCd: '150', from: '2026-07-30', to: '2026-08-28', ...over,
});

describe('T1 — 최근 신규 등록 (FR-RU-110)', () => {
  it('구간 안에 새로 올라온 것만 센다', () => {
    const s = summarizeNewContents([
      content({ contentId: 'a', createdTime: '20260820103000' }),
      content({ contentId: 'b', createdTime: '20260101090000' }),
    ], window());
    expect(s.count).toBe(1);
  });

  it('🔴 경계 이틀을 통째로 넣는다', () => {
    // `YYYYMMDD` 뒤에 시각이 붙어 오므로 날짜만 비교하면 마지막 날 오후가 빠진다
    const s = summarizeNewContents([
      content({ contentId: 'a', createdTime: '20260730000000' }),
      content({ contentId: 'b', createdTime: '20260828235959' }),
      content({ contentId: 'c', createdTime: '20260729235959' }),
      content({ contentId: 'd', createdTime: '20260829000000' }),
    ], window());
    expect(s.count).toBe(2);
  });

  it('🔴 createdtime 이 없거나 모양이 아니면 세지 않는다', () => {
    // 모르는 것을 신규로 세면 없는 신호가 생긴다
    for (const bad of ['', '20260820', 'x'.repeat(14), '2026-08-20 10:30']) {
      expect(summarizeNewContents([content({ createdTime: bad })], window()).count, bad).toBe(0);
    }
  });

  it('🔴 시군구가 지정되면 시군구까지 같아야 한다', () => {
    // 시도만 보면 강원 상품에 삼척 콘텐츠가 「내 지역 신호」로 잡힌다
    const s = summarizeNewContents([
      content({ contentId: 'a', ldongSignguCd: '150' }),
      content({ contentId: 'b', ldongSignguCd: '230' }),
    ], window());
    expect(s.count).toBe(1);
  });

  it('시군구가 없으면 시도로 본다', () => {
    const s = summarizeNewContents([
      content({ contentId: 'a', ldongRegnCd: '51', ldongSignguCd: '230' }),
      content({ contentId: 'b', ldongRegnCd: '11', ldongSignguCd: '110' }),
    ], window({ ldongSignguCd: null }));
    expect(s.count).toBe(1);
  });

  it('관심 키워드가 걸리면 맞는 것만 센다 (FR-RU-112)', () => {
    const items = [content({ contentId: 'a', matchesKeyword: true }), content({ contentId: 'b' })];
    expect(summarizeNewContents(items, window()).count).toBe(2);
    expect(summarizeNewContents(items, window(), { keywordFiltered: true }).count).toBe(1);
  });
});

describe('T2 — 여행기간 ±3일 행사 (FR-RU-120)', () => {
  const w = window({ from: '2026-09-07', to: '2026-09-14' });

  it('기간이 하루라도 겹치면 센다', () => {
    const s = summarizeFestivals([
      content({ contentId: 'a', contentTypeId: '15', eventStart: '2026-09-14', eventEnd: '2026-09-20' }),
      content({ contentId: 'b', contentTypeId: '15', eventStart: '2026-08-01', eventEnd: '2026-09-07' }),
      content({ contentId: 'c', contentTypeId: '15', eventStart: '2026-09-15', eventEnd: '2026-09-20' }),
    ], w);
    expect(s.count).toBe(2);
  });

  it('🔴 기간을 모르는 행사를 겹친 것으로 세지 않는다', () => {
    /*
     * 결측을 「그 기간에 열린다」로도 「안 열린다」로도 읽지 않는다. 세면 없는 행사가
     * 생기고, 「0건」이라 말하면 모르는 것을 없다고 하는 셈이다.
     */
    const s = summarizeFestivals([
      content({ contentTypeId: '15', eventStart: '2026-09-10', eventEnd: null }),
      content({ contentTypeId: '15', eventStart: null, eventEnd: '2026-09-10' }),
      content({ contentTypeId: '15' }),
    ], w);
    expect(s.count).toBe(0);
  });
});

describe('건수와 분포뿐이다 (FR-RU-121 · 122)', () => {
  it('🔴 신호에 강도 점수가 없다', () => {
    /*
     * 「신호 강도 7.2」 같은 값을 만드는 순간 관측이 아니라 예측이다 (FR-RU-121).
     * 필드 목록으로 못 박는다 — 나중에 점수를 더하면 여기가 걸린다.
     */
    const s = summarizeNewContents([content()], window());
    expect(Object.keys(s).sort()).toEqual(['byType', 'count', 'window']);
    for (const forbidden of ['score', 'strength', 'intensity', 'trend', 'rank', 'prediction']) {
      expect(JSON.stringify(s), forbidden).not.toContain(forbidden);
    }
  });

  it('🔴 유형 분포는 건수만 담고 입력 순서에 흔들리지 않는다', () => {
    // 같은 입력이 다른 순서를 내면 화면이 실행마다 달라 보인다 (NF-MT-001 과 같은 취지)
    const items = ['39', 'UNKNOWN', '12', '12'].map((t, i) =>
      content({ contentId: String(i), contentTypeId: t === 'UNKNOWN' ? '' : t }));
    const forward = summarizeNewContents(items, window()).byType;
    const backward = summarizeNewContents([...items].reverse(), window()).byType;

    expect(forward).toEqual({ 12: 2, 39: 1, UNKNOWN: 1 });
    expect(Object.keys(forward)).toEqual(Object.keys(backward));
  });

  it('🔴 유형을 모르면 UNKNOWN 으로 남긴다 — 조용히 버리지 않는다', () => {
    // 버리면 count 와 byType 합이 어긋나 화면이 「3건인데 분포는 2건」을 보여준다
    const s = summarizeNewContents([
      content({ contentId: 'a', contentTypeId: '12' }),
      content({ contentId: 'b', contentTypeId: '' }),
    ], window());
    expect(s.byType).toEqual({ 12: 1, UNKNOWN: 1 });
    expect(Object.values(s.byType).reduce((a, b) => a + b, 0)).toBe(s.count);
  });
});

describe('조회 구간 (FR-MO-056)', () => {
  const region = { ldongRegnCd: '51', ldongSignguCd: '150' };

  it('T1 은 오늘까지 30일이다', () => {
    expect(t1Window('2026-08-28', region)).toMatchObject({ from: '2026-07-30', to: '2026-08-28' });
    expect(T1_DEFAULT_DAYS).toBe(30);
  });

  it('T1 기간은 설정으로 바뀐다 (FR-RU-111)', () => {
    expect(t1Window('2026-08-28', region, 7)?.from).toBe('2026-08-22');
  });

  it('🔴 말이 안 되는 기간은 창을 안 만든다', () => {
    // 0 일이면 조회 구간이 뒤집혀 아무것도 안 잡히는데 화면에는 「최근 0일」이라 뜬다
    for (const bad of [0, -3, 1.5, Number.NaN]) {
      expect(t1Window('2026-08-28', region, bad), String(bad)).toBeNull();
    }
    expect(t1Window('2026-13-40', region)).toBeNull();
  });

  it('T2 는 여행기간 앞뒤 3일이다', () => {
    // 2026-09-10 출발 1박 2일 → 09-10 ~ 09-11 에 ±3일
    expect(t2Window('2026-09-10', 1, region)).toMatchObject({ from: '2026-09-07', to: '2026-09-14' });
    expect(T2_MARGIN_DAYS).toBe(3);
  });

  it('🔴 창에 조회 조건이 함께 담긴다 — 화면이 그대로 적는다', () => {
    // 「강원 강릉 · 최근 30일」 처럼 무엇으로 뽑았는지 밝혀야 한다 (FR-MO-056)
    expect(t1Window('2026-08-28', region)).toMatchObject({ ldongRegnCd: '51', ldongSignguCd: '150' });
    expect(summarizeNewContents([], window()).window).toEqual(window());
  });
});
