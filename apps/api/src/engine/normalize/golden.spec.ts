import { describe, expect, it } from 'vitest';
import { MAX_SCOPE_LENGTH } from './closed';
import { parseOperatingInfo } from './parse';

/**
 * 골든 케이스 — 파서를 고칠 때마다 반드시 통과해야 하는 실측 3건 (파싱규칙 §7).
 *
 * **이 3건이 깨지면 파서 변경을 되돌린다.** 각각 다른 종류의 함정을 대표한다.
 */
describe('골든 케이스 3건', () => {
  it('① 감자유원지(2941250) — 한 필드에 정보가 4개다', () => {
    const out = parseOperatingInfo({
      contentTypeId: 39,
      raw: {
        restdatefood: '연중무휴',
        opentimefood: '- 11:00~20:00- 준비시간 15:30~17:00- 점심 마지막 주문 15:00 / 저녁 마지막 주문 19:30',
      },
    });

    expect(out.openHours?.open).toBe('11:00');
    expect(out.openHours?.close).toBe('20:00');
    expect(out.openHours?.breaks).toEqual([{ from: '15:30', to: '17:00' }]);
    expect(out.confidence.overall).toBe('CONFIRMED');

    /*
     * ⚠️ 명세 불일치 — `docs/파싱규칙.md` §7① 은 마감을 `[{label:'점심',at:'15:00'},…]` 배열로
     *    적었지만 정본인 DR-NM 5-2 · 5-3 의 스키마는 `HH:mm | null` 단일값이다.
     *    정본을 따르고 **가장 늦은 마감**을 쓴다. 두 마감 사이는 준비시간이 덮는다.
     */
    expect(out.openHours?.admissionCutoff).toBe('19:30');
  });

  it('② 오죽헌·시립박물관(129784) — 라벨 병기 · 괄호 예외', () => {
    const out = parseOperatingInfo({
      contentTypeId: 14,
      raw: {
        restdateculture: '연중무휴(1월 1일/설날/추석 당일은 오죽헌만 개방, 실내 전시실 휴관)',
        usetimeculture: '매표시간 09:00~17:00 관람시간 09:00~18:00',
      },
    });

    // 매표 마감(17:00)을 운영시간으로 오인하면 17:00~18:00 방문이 전부 차단이 된다
    expect(out.openHours?.open).toBe('09:00');
    expect(out.openHours?.close).toBe('18:00');
    expect(out.openHours?.admissionCutoff).toBe('17:00');
    expect(out.confidence.byPath.openHours).toBe('CONFIRMED');

    // DR-NM-011 ② — 시설 일부만 휴관이므로 alwaysOpen 을 유지하고 예외를 partialClosed 에 담는다
    expect(out.alwaysOpen).toBe(true);
    expect(out.partialClosed).toEqual([
      { scope: '실내 전시실', on: ['01-01', 'LUNAR_NEW_YEAR', 'CHUSEOK'] },
    ]);
    // 두 경우 모두 신뢰도를 추정으로 낮춘다 (DR-NM-011 · 032)
    expect(out.confidence.byPath.alwaysOpen).toBe('ESTIMATED');
    expect(out.confidence.overall).toBe('ESTIMATED');
    // 전체 휴무 필드로는 새지 않는다 — partialClosed 만으로는 R01 차단이 나지 않는다 (DR-NM-012)
    expect(out.weeklyClosed).toEqual([]);
    expect(out.fixedClosed).toEqual([]);
    expect(out.holidayRule).toEqual([]);
  });

  it('③ 금진리321카라반(2792194) — 입실/퇴실을 운영시간으로 읽지 않는다', () => {
    const out = parseOperatingInfo({
      contentTypeId: 28,
      raw: { restdateleports: '연중무휴', usetimeleports: '  • 입실 15:00- 퇴실 11:00' },
    });

    expect(out.checkIn).toBe('15:00');
    expect(out.checkOut).toBe('11:00');
    /*
     * openHours 가 비어 있어야 한다. `open=15:00 · close=11:00` 으로 읽으면 DR-NM-023
     * (익일 종료)이 걸려 **심야 영업**으로 오판하고 낮 방문이 전부 차단이 된다 (DR-NM-026).
     */
    expect(out.openHours).toBeNull();
    expect(out.dayOfWeekHours).toEqual([]);
  });
});

describe('명세 본문에 실린 실측 예시', () => {
  it('요일 라벨 블록을 요일별 운영시간으로 편다 (FR-AU-015 · 파싱규칙 §2)', () => {
    const out = parseOperatingInfo({
      contentTypeId: 39,
      raw: {
        restdatefood: '매주 화요일',
        opentimefood:
          '[월요일]- 07:40~16:00- 마지막 주문 15:45[수요일~일요일]- 07:40~19:30- 준비시간 15:30~17:00- 마지막 주문 19:15',
      },
    });

    expect(out.openHours).toBeNull();
    expect(out.dayOfWeekHours).toEqual([
      { days: ['MON'], open: '07:40', close: '16:00', breaks: [], admissionCutoff: '15:45' },
      {
        days: ['WED', 'THU', 'FRI', 'SAT', 'SUN'],
        open: '07:40', close: '19:30',
        breaks: [{ from: '15:30', to: '17:00' }], admissionCutoff: '19:15',
      },
    ]);
    expect(out.weeklyClosed).toEqual(['TUE']);
  });

  it('하절기·동절기를 기간별 운영시간으로 편다', () => {
    const out = parseOperatingInfo({
      contentTypeId: 12,
      raw: {
        restdate: '매주 월요일 (단, 월요일이 공휴일인 경우 그 다음날 휴관) / 1월 1일 / 설·추석 당일',
        usetime:
          '- 하절기(4월~10월) 09:00~17:30 (매표 마감 16:30)- 동절기(11월~3월) 09:00~16:30 (매표 마감 15:30)',
      },
    });

    expect(out.seasonalHours).toEqual([
      { from: '04-01', to: '10-31', label: '하절기', open: '09:00', close: '17:30', breaks: [], admissionCutoff: '16:30' },
      { from: '11-01', to: '03-31', label: '동절기', open: '09:00', close: '16:30', breaks: [], admissionCutoff: '15:30' },
    ]);
    expect(out.weeklyClosed).toEqual(['MON']);
    expect(out.fixedClosed).toEqual(['01-01']);
    expect(out.holidayRule).toEqual(['CHUSEOK', 'LUNAR_NEW_YEAR']);
    expect(out.conditionalRule).toEqual([
      // 원문 절을 담던 `note` 는 없앴다 — R01 이 그것을 finding.message 로 옮겨 불변 기록에
      // 남겼다 (DR-NM-014 · 이슈 #361). 뜻은 `kind` 가 들고 있다
      { kind: 'HOLIDAY_NEXT_DAY', appliesTo: ['MON'] },
    ]);
    // 조건부 경로는 추정 고정이다 (DR-NM-031) — 차단 근거가 될 수 없다 (FR-AU-008)
    expect(out.confidence.byPath.conditionalRule).toBe('ESTIMATED');
  });

  it('`<br>` 은 실측 데이터다 — 조각 경계로 다룬다 (파싱규칙 §1)', () => {
    const out = parseOperatingInfo({
      contentTypeId: 38,
      raw: { restdateshopping: '매주 월요일<br>※ 7 월~8 월은 무휴', opentime: '06:00~23:00<br>※ 점포별 상이함' },
    });

    expect(out.weeklyClosed).toEqual(['MON']);
    // 점포별로 다르면 운영시간을 단정할 수 없다
    expect(out.confidence.byPath.openHours).not.toBe('CONFIRMED');
    expect(out.unparsed.some((u) => u.reason === 'TARGET_VARIES')).toBe(true);
  });
});

/**
 * 정규화 결과에 **원문 절이 남지 않는가** (DR-NM-014 · 이슈 #361).
 *
 * `conditionalRule.note` 가 `restdate` 의 절을 그대로 담았고 R01 이 그것을 `finding.message`
 * 로 옮겨 **불변 기록에 영구히 남겼다.** 조각 인용은 `unparsed` 자리에서만 허용된다.
 */
describe('원문 절이 정규화 결과에 남지 않는다 (DR-NM-014)', () => {
  const CLAUSE = '단, 월요일이 공휴일인 경우 그 다음날 휴관';

  it('조건부 휴무를 구조로만 남긴다 — 절을 담지 않는다', () => {
    const out = parseOperatingInfo({
      contentTypeId: 14,
      raw: { restdateculture: `매주 월요일(${CLAUSE})`, usetimeculture: '09:00~18:00' },
    });

    expect(out.conditionalRule.length).toBeGreaterThan(0);
    // `unparsed` 는 조각 인용이 허용된 자리라 빼고 본다
    const structured = JSON.stringify({ ...out, unparsed: [] });
    expect(structured).not.toContain(CLAUSE);
    expect(structured).not.toContain('공휴일인 경우');
  });

  it('시설 일부 휴관 대상어는 상한 안에 있다', () => {
    const out = parseOperatingInfo({
      contentTypeId: 14,
      raw: {
        restdateculture: '연중무휴(1월 1일/설날/추석 당일은 오죽헌만 개방, 실내 전시실 휴관)',
        usetimeculture: '09:00~18:00',
      },
    });

    expect(out.partialClosed.length).toBeGreaterThan(0);
    for (const p of out.partialClosed) {
      // 대상어는 판독 산출물이라 담을 수 있다. 문장이 통째로 들어오는 것만 막는다
      expect(p.scope.length).toBeLessThanOrEqual(MAX_SCOPE_LENGTH);
    }
  });
});
