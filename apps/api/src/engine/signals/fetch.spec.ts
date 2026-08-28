import { describe, expect, it } from 'vitest';
import { festivalQueryDate, reachedOlderThan, toKtoDay, toSignalContent } from './fetch';
import type { SignalContent } from './types';

/** 실제 `areaBasedList2` 응답 필드 구성 (05_areaBasedList2 픽스처) */
const listItem = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  contentid: '2541883', contenttypeid: '15', createdtime: '20180406184032',
  modifiedtime: '20260819131329', lDongRegnCd: '51', lDongSignguCd: '150',
  // 공사 원문. 우리가 담지 않아야 하는 것들이다
  title: '강릉 국가유산야행', addr1: '강원특별자치도 강릉시 임영로131번길 6',
  firstimage: 'https://tong.visitkorea.or.kr/x.jpg', tel: '033-823-3206', zipcode: '25534',
  ...over,
});

describe('목록 응답 해석', () => {
  it('🔴 공사 원문을 담지 않는다 (FR-MO-002)', () => {
    /*
     * 허용 목록으로 본다. 응답에 필드가 늘거나 우리가 하나를 더 담으면 여기가 걸린다 —
     * 그때 그게 코드인지 원문인지 판단하게 하려는 검사다 (DB 명세서 6-4).
     */
    const parsed = toSignalContent(listItem());
    expect(Object.keys(parsed).sort()).toEqual([
      'contentId', 'contentTypeId', 'createdTime', 'eventEnd', 'eventStart',
      'ldongRegnCd', 'ldongSignguCd', 'matchesKeyword',
    ]);
    for (const leak of ['강릉 국가유산야행', '강원특별자치도', 'firstimage', 'tel', 'zipcode']) {
      expect(JSON.stringify(parsed), leak).not.toContain(leak);
    }
  });

  it('🔴 키워드는 판정만 하고 제목은 안 넘긴다 (FR-RU-112)', () => {
    // 제목을 넘기면 신호 객체를 통해 원문이 화면과 로그로 샌다
    const hit = toSignalContent(listItem(), ['야행']);
    expect(hit.matchesKeyword).toBe(true);
    expect(JSON.stringify(hit)).not.toContain('야행');

    expect(toSignalContent(listItem(), ['커피축제']).matchesKeyword).toBe(false);
    // 빈 키워드는 아무거나 맞는 것으로 치지 않는다
    expect(toSignalContent(listItem(), ['']).matchesKeyword).toBe(false);
    expect(toSignalContent(listItem()).matchesKeyword).toBe(false);
  });

  it('행사기간을 ISO 로 읽고, 없으면 null 이다', () => {
    expect(toSignalContent(listItem({ eventstartdate: '20260404', eventenddate: '20260411' })))
      .toMatchObject({ eventStart: '2026-04-04', eventEnd: '2026-04-11' });
    expect(toSignalContent(listItem()).eventStart).toBeNull();
  });

  it('법정동 코드가 비면 없는 것으로 읽는다', () => {
    const parsed = toSignalContent(listItem({ lDongRegnCd: '', lDongSignguCd: '  ' }));
    expect(parsed.ldongRegnCd).toBeNull();
    expect(parsed.ldongSignguCd).toBeNull();
  });
});

describe('T1 페이지 조기 종료 (EI-KT-021)', () => {
  const row = (createdTime: string): SignalContent =>
    ({ ...toSignalContent(listItem()), createdTime });

  it('마지막 줄이 기준일보다 이르면 그만 읽는다', () => {
    // arrange=D 는 생성일 내림차순이라 뒤는 더 오래된 것뿐이다
    expect(reachedOlderThan([row('20260826103000'), row('20260728090000')], '2026-07-30')).toBe(true);
  });

  it('마지막 줄이 아직 구간 안이면 더 읽는다', () => {
    expect(reachedOlderThan([row('20260826103000'), row('20260801090000')], '2026-07-30')).toBe(false);
  });

  it('🔴 경계 당일은 아직 구간 안이다', () => {
    // 기준일 자정 이후는 포함이다. 여기서 끊으면 그날 등록분을 통째로 놓친다
    expect(reachedOlderThan([row('20260730000000')], '2026-07-30')).toBe(false);
    expect(reachedOlderThan([row('20260729235959')], '2026-07-30')).toBe(true);
  });

  it('🔴 정렬을 못 믿을 값이면 멈추지 않는다', () => {
    /*
     * `createdtime` 이 14자리가 아니면 어디까지 읽었는지 판단할 근거가 없다. 멈추면
     * 뒤에 있는 신규 등록을 놓치고 「최근 30일에 0건」이라 말하게 된다.
     */
    for (const bad of ['', '20260826', 'x'.repeat(14)]) {
      expect(reachedOlderThan([row(bad)], '2026-07-30'), bad).toBe(false);
    }
  });

  it('빈 페이지면 끝이다', () => {
    expect(reachedOlderThan([], '2026-07-30')).toBe(true);
  });
});

describe('공사 날짜 형식', () => {
  it('YYYYMMDD 로 바꾼다', () => {
    expect(toKtoDay('2026-09-07')).toBe('20260907');
  });

  it('T2 는 구간 시작일로 부른다 (EI-KT-010)', () => {
    // eventStartDate 는 "그 날짜에 아직 끝나지 않은 행사" 를 준다. 보정을 더하지 않는다
    expect(festivalQueryDate({
      ldongRegnCd: '51', ldongSignguCd: '150', from: '2026-09-07', to: '2026-09-14',
    })).toBe('20260907');
  });
});
