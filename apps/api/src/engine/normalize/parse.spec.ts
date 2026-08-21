import { describe, expect, it } from 'vitest';
import { parseOperatingInfo } from './parse';
import { SCHEMA_VERSION } from './types';

const food = (restdatefood: string, opentimefood = ''): ReturnType<typeof parseOperatingInfo> =>
  parseOperatingInfo({ contentTypeId: 39, raw: { restdatefood, opentimefood } });

const spot = (restdate: string, usetime = ''): ReturnType<typeof parseOperatingInfo> =>
  parseOperatingInfo({ contentTypeId: 12, raw: { restdate, usetime } });

describe('스키마 계약', () => {
  it('schemaVersion 을 담는다 (DR-NM-002)', () => {
    expect(food('연중무휴').schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('sourceFieldNames 는 값이 아니라 **필드명**이다', () => {
    expect(food('연중무휴').sourceFieldNames).toEqual(['restdatefood', 'opentimefood']);
  });
});

describe('휴무 축 병합 (DR-NM-010 ~ 012)', () => {
  it('배열형 필드를 합집합으로 병합하고 중복을 없앤다', () => {
    const out = spot('매주 월요일 / 매주 월요일 / 매주 화요일 / 1월 1일 / 설·추석 당일');
    expect(out.weeklyClosed).toEqual(['MON', 'TUE']);
    expect(out.fixedClosed).toEqual(['01-01']);
    expect(out.holidayRule).toEqual(['CHUSEOK', 'LUNAR_NEW_YEAR']);
  });

  it('요일 범위와 나열을 모두 편다', () => {
    expect(spot('매주 수요일~목요일').weeklyClosed).toEqual(['WED', 'THU']);
    expect(spot('매주 토요일, 일요일').weeklyClosed).toEqual(['SAT', 'SUN']);
    expect(spot('주말').weeklyClosed).toEqual(['SAT', 'SUN']);
  });

  it('매월 N번째 요일을 조각으로 흩뜨리지 않는다', () => {
    // `매월 둘째 주 ·넷째 주 목요일` — `·` 로 먼저 자르면 앞쪽이 미아가 된다
    expect(spot('매월 둘째 주 ·넷째 주 목요일').nthWeekday).toEqual([
      { nth: 2, day: 'THU' }, { nth: 4, day: 'THU' },
    ]);
    expect(spot('매달 셋째 월요일').nthWeekday).toEqual([{ nth: 3, day: 'MON' }]);
    expect(spot('매월 둘째, 넷째 일요일').nthWeekday).toEqual([
      { nth: 2, day: 'SUN' }, { nth: 4, day: 'SUN' },
    ]);
  });

  it('`명절` 한 단어는 설과 추석 둘 다를 뜻한다 (실측 17건)', () => {
    expect(spot('명절').holidayRule).toEqual(['CHUSEOK', 'LUNAR_NEW_YEAR']);
  });

  it('실측 오타 `연증무휴` 를 명시적으로 받는다', () => {
    // 흐릿한 매칭 대신 관측된 오타만 받는다 — 무엇을 왜 받는지가 코드에 남아야 한다
    expect(spot('연증무휴').alwaysOpen).toBe(true);
  });

  describe('DR-NM-011 — alwaysOpen 과 휴무 조각이 함께 나올 때', () => {
    it('① 시설 전체 휴관이면 alwaysOpen 을 내리고 휴무 항목을 유지한다', () => {
      const out = spot('연중무휴 / 매주 월요일');
      expect(out.alwaysOpen).toBe(false);
      expect(out.weeklyClosed).toEqual(['MON']);
      // 두 경로 모두 추정으로 낮춘다 (DR-NM-032)
      expect(out.confidence.byPath.alwaysOpen).toBe('ESTIMATED');
      expect(out.confidence.byPath.weeklyClosed).toBe('ESTIMATED');
    });

    it('② 시설 일부 휴관이면 alwaysOpen 을 유지하고 partialClosed 에 담는다', () => {
      const out = spot('연중무휴(1월 1일은 실내 전시실 휴관)');
      expect(out.alwaysOpen).toBe(true);
      expect(out.partialClosed).toEqual([{ scope: '실내 전시실', on: ['01-01'] }]);
      expect(out.confidence.byPath.alwaysOpen).toBe('ESTIMATED');
    });

    it('조건부 휴무는 alwaysOpen 을 내리지 않는다 — 확정된 휴무일이 아니다', () => {
      const out = spot('연중무휴※ 단, 기상특보(풍랑주의보, 풍랑경보 등) 발령 시 휴무');
      expect(out.alwaysOpen).toBe(true);
      expect(out.conditionalRule).toHaveLength(1);
      expect(out.confidence.byPath.conditionalRule).toBe('ESTIMATED');
    });
  });

  it('조건절은 앞선 요일을 수식한다', () => {
    const out = spot('매주 월요일 (단, 월요일이 공휴일인 경우 그 다음날 휴관)');
    expect(out.conditionalRule[0]).toMatchObject({ kind: 'HOLIDAY_NEXT_DAY', appliesTo: ['MON'] });
  });
});

describe('운영시간 축', () => {
  it('상시 개방은 하루 종일 열린 것으로 읽는다 (실측 49건)', () => {
    expect(spot('연중무휴', '상시 개방').openHours).toEqual({
      open: '00:00', close: '24:00', breaks: [], admissionCutoff: null,
    });
  });

  it('심야 영업을 익일 종료로 남긴다 (DR-NM-023)', () => {
    const out = spot('연중무휴', '18:00~02:00');
    expect(out.openHours).toMatchObject({ open: '18:00', close: '02:00' });
  });

  it('FR-AU-014 — 라벨 없는 범위가 둘 이상이면 첫 값을 운영시간으로 단정하지 않는다', () => {
    // 실측: 속초등대전망대 `- 전망대 09:00~17:00- 야외공간 09:00~18:00`
    const out = spot('연중무휴', '- 전망대 09:00~17:00- 야외공간 09:00~18:00');
    expect(out.openHours).toBeNull();
    expect(out.confidence.byPath.openHours).toBe('UNPARSED');
    expect(out.unparsed.some((u) => u.affects.includes('openHours'))).toBe(true);
  });

  it('같은 값을 두 번 말하는 건 충돌이 아니다', () => {
    const out = spot('연중무휴', '- 09:00~18:00- 09:00~18:00');
    expect(out.openHours).toMatchObject({ open: '09:00', close: '18:00' });
  });

  it('DR-NM-016 — 같은 요일에 서로 다른 시간을 주장하면 그 요일 항목을 만들지 않는다', () => {
    const out = spot('연중무휴', '[월요일]09:00~18:00[월요일~화요일]10:00~20:00');
    expect(out.dayOfWeekHours.map((d) => d.days)).toEqual([['MON']]);
    // 살아남은 항목이 있으므로 경로 자체는 쓸 수 있다. 신뢰도만 낮춘다 (DR-NM-032)
    expect(out.confidence.byPath.dayOfWeekHours).toBe('ESTIMATED');
    expect(out.unparsed.some((u) => u.reason === 'CONDITIONAL')).toBe(true);
    expect(out.unparsed.every((u) => !u.affects.includes('dayOfWeekHours'))).toBe(true);
  });

  it('요일 항목이 하나도 안 남으면 그때는 경로를 확인 불가로 내린다 (DR-NM-033)', () => {
    const out = spot('연중무휴', '[월요일]09:00~18:00[월요일]10:00~20:00[월요일]11:00~21:00');
    expect(out.dayOfWeekHours.map((d) => d.days)).toEqual([['MON']]);
    expect(out.unparsed.filter((u) => u.reason === 'CONDITIONAL').length).toBeGreaterThan(0);
  });

  it('기간 없는 계절 라벨은 기간을 지어내지 않는다', () => {
    // `- 하절기 09:30~18:00- 동절기 09:30~17:00` — 언제부터 하절기인지 원문에 없다
    const out = spot('연중무휴', '- 하절기 09:30~18:00- 동절기 09:30~17:00');
    expect(out.seasonalHours).toEqual([]);
  });
});

describe('입실 · 퇴실 (DR-NM-024 · 026)', () => {
  it('숙박(32)은 휴무 · 시각 판정을 하지 않고 입실 · 퇴실만 읽는다', () => {
    const out = parseOperatingInfo({
      contentTypeId: 32,
      raw: { checkintime: '15:00', checkouttime: '11:00', restdate: '매주 월요일' },
    });
    expect(out.checkIn).toBe('15:00');
    expect(out.checkOut).toBe('11:00');
    expect(out.sourceFieldNames).toEqual(['checkintime', 'checkouttime']);
    // 휴무 판정 대상이 아니다 (FR-AU-011) — restdate 가 있어도 읽지 않는다
    expect(out.weeklyClosed).toEqual([]);
    expect(out.openHours).toBeNull();
  });

  it('숙박이 아닌 유형의 운영시간 필드에도 입실 · 퇴실이 담긴다 (DR-NM-026 실측)', () => {
    const out = parseOperatingInfo({
      contentTypeId: 28,
      raw: { restdateleports: '연중무휴', usetimeleports: '- 입실 14:00~22:00- 퇴실 11:00' },
    });
    expect(out.checkIn).toBe('14:00');
    expect(out.checkOut).toBe('11:00');
    // openHours 로 읽으면 심야 영업으로 오판해 낮 방문이 전부 차단이 된다
    expect(out.openHours).toBeNull();
  });
});

describe('해석 실패를 정상으로 판정하지 않는다 (FR-AU-009 · DR-NM-004 · 033)', () => {
  it('결측은 정상 산출물이지만 판정에는 쓸 수 없다', () => {
    const out = spot('', '');
    expect(out.unparsed.map((u) => u.reason)).toEqual(['MISSING', 'MISSING']);
    expect(out.confidence.byPath.weeklyClosed).toBe('UNPARSED');
    expect(out.confidence.byPath.openHours).toBe('UNPARSED');
    expect(out.confidence.overall).toBe('UNPARSED');
  });

  it.each([
    ['점포 별로 상이함', 'TARGET_VARIES'],
    ['예약시 운영', 'REFERENCE'],
    ['홈페이지 참조', 'REFERENCE'],
  ])('%s → %s 로 남긴다 (파싱규칙 §6)', (raw, reason) => {
    const out = spot(raw, raw);
    expect(out.unparsed.some((u) => u.reason === reason)).toBe(true);
    expect(out.confidence.byPath.openHours).toBe('UNPARSED');
  });

  it('`점포별 상이함` 은 시각을 읽었어도 그 시각을 무효로 만든다', () => {
    // 실측: 강릉 동부시장 `06:00~23:00<br>※ 점포별 상이함`
    const out = spot('연중무휴', '06:00~23:00※ 점포별 상이함');
    expect(out.confidence.byPath.openHours).toBe('UNPARSED');
  });

  it('`전화문의` 안내는 읽은 시각을 무효로 만들지 않는다', () => {
    const out = spot('연중무휴', '09:00~18:00※ 자세한 사항은 전화문의 요망');
    expect(out.openHours).toMatchObject({ open: '09:00', close: '18:00' });
    expect(out.confidence.byPath.openHours).toBe('CONFIRMED');
    // 안내는 버리지 않는다 (DR-NM-004)
    expect(out.unparsed.some((u) => u.reason === 'REFERENCE' && u.affects.length === 0)).toBe(true);
  });

  it('조각 원문만 담고 원문 전문을 복사하지 않는다 (DR-NM-014)', () => {
    const out = spot('연중무휴', `${'가'.repeat(300)}`);
    for (const u of out.unparsed) expect(u.fragment.length).toBeLessThanOrEqual(200);
  });
});

describe('신뢰도 (DR-NM-030 ~ 034)', () => {
  it('사전 파서가 처리한 조각은 확정이다 (DR-NM-031)', () => {
    expect(spot('매주 월요일', '09:00~18:00').confidence.byPath).toMatchObject({
      weeklyClosed: 'CONFIRMED', openHours: 'CONFIRMED',
    });
  });

  it('overall 은 byPath 의 최솟값이다 (DR-NM-034)', () => {
    const out = spot('매주 월요일 (단, 월요일이 공휴일인 경우 익일 휴관)', '09:00~18:00');
    expect(out.confidence.byPath.weeklyClosed).toBe('CONFIRMED');
    expect(out.confidence.byPath.conditionalRule).toBe('ESTIMATED');
    expect(out.confidence.overall).toBe('ESTIMATED');
  });

  it('신뢰도는 필드 경로 단위다 — 한 원문에 확정과 추정이 섞이는 게 기본형이다 (DR-NM-005)', () => {
    const out = spot('매주 월요일 (단, 공휴일인 경우 익일 휴관)', '09:00~18:00');
    expect(Object.keys(out.confidence.byPath).length).toBeGreaterThan(1);
  });
});

describe('결정론성 (NF-MT-001)', () => {
  it('같은 입력이면 언제나 같은 결과다', () => {
    const raw = {
      restdatefood: '매주 월요일 / 1월 1일 / 설·추석 당일',
      opentimefood: '- 11:00~20:00- 준비시간 15:30~17:00- 마지막 주문 19:30',
    };
    const runs = Array.from({ length: 5 }, () => parseOperatingInfo({ contentTypeId: 39, raw }));
    for (const r of runs) expect(r).toEqual(runs[0]);
  });

  it('조각 순서가 달라도 배열 결과는 같은 순서로 나온다', () => {
    expect(spot('매주 화요일 / 매주 월요일').weeklyClosed).toEqual(
      spot('매주 월요일 / 매주 화요일').weeklyClosed,
    );
  });
});
