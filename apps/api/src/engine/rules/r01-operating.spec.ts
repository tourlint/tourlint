import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ContentTypeId } from '@tourlint/shared';
import { KOREAN_HOLIDAYS } from '../calendar/holidays';
import { parseOperatingInfo } from '../normalize/parse';
import { R01OperatingRule } from './r01-operating';
import { DEFAULT_AUDIT_SETTINGS } from './types';
import type { AuditItem, Finding, ItineraryContext } from './types';

const FIXTURES = join(__dirname, '../../../../../fixtures/kto');
const rule = new R01OperatingRule();

/** `detailIntro2` 스냅샷에서 항목 하나를 꺼낸다 */
function intro(file: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'));
  const item = (raw as { response: { body: { items: { item: unknown } } } }).response.body.items.item;
  return (Array.isArray(item) ? item[0] : item) as Record<string, unknown>;
}

interface CaseInput {
  readonly contentTypeId: ContentTypeId;
  readonly raw: Record<string, unknown>;
  readonly date: string;
  readonly start?: string;
  readonly end?: string | null;
  readonly itemType?: AuditItem['itemType'];
  readonly placeLabel?: string;
}

function evaluate(input: CaseInput): readonly Finding[] {
  const item: AuditItem = {
    id: 1, dayNo: 1, seq: 1,
    date: input.date,
    startTime: input.start ?? '10:00',
    endTime: input.end === undefined ? '11:00' : input.end,
    endTimeSource: 'INPUT',
    lclsSystm1: null,
    lclsSystm2: null,
    lclsSystm3: null,
    itemType: input.itemType ?? 'SIGHT',
    placeLabel: input.placeLabel ?? '테스트 장소',
    matchStatus: 'CONFIRMED',
    content: {
      ktoContentId: '1',
      contentTypeId: input.contentTypeId,
      normalized: parseOperatingInfo({ contentTypeId: input.contentTypeId, raw: input.raw }),
      showFlag: 1,
      eventPeriod: null,
    },
  };
  const ctx: ItineraryContext = { productId: 1, items: [item], holidays: KOREAN_HOLIDAYS, settings: DEFAULT_AUDIT_SETTINGS };
  return rule.evaluate(ctx);
}

/** 관광지(12) 한 곳을 원문으로 세워 판정한다 */
const spot = (restdate: string, usetime: string, date: string, start?: string, end?: string | null): readonly Finding[] =>
  evaluate({ contentTypeId: 12, raw: { restdate, usetime }, date, start, end });

describe('[1단계] 휴무 판정 — 위에서부터, 걸리면 즉시 CLOSED (DR-NM 5-5)', () => {
  it('1-1 양력 고정일', () => {
    const [f] = spot('1월 1일', '09:00~18:00', '2026-01-01');
    expect(f).toMatchObject({ severity: 'BLOCKER', reasonCode: 'REST_DAY_CONFLICT' });
    expect(f?.evidence.step).toBe('1-1');
  });

  it('1-2 명절 — 설날 당일', () => {
    const [f] = spot('설·추석 당일', '09:00~18:00', '2026-02-17');
    expect(f?.evidence.step).toBe('1-2');
    expect(f?.message).toContain('설날');
  });

  it('1-2 명절은 **당일만** 본다 — 연휴는 열려 있을 수 있다', () => {
    expect(spot('설·추석 당일', '09:00~18:00', '2026-02-16')).toHaveLength(0);
  });

  it('1-2 법정공휴일', () => {
    // 실측: 강릉 한복 문화 창작소(3379937) `매주 토요일~일요일 / 법정공휴일`
    const [f] = spot('매주 토요일~일요일 / 법정공휴일', '09:00~18:00', '2026-10-09');
    expect(f).toMatchObject({ severity: 'BLOCKER', reasonCode: 'REST_DAY_CONFLICT' });
    expect(f?.message).toContain('한글날');
  });

  it('1-2 표에 없는 연도는 "공휴일 아님" 이 아니라 "모른다" 다', () => {
    // 조용히 통과시키면 그 해 전체의 휴무 판정이 소리 없이 틀린다
    const [f] = spot('법정공휴일', '09:00~18:00', '2030-10-09');
    expect(f).toMatchObject({ severity: 'UNVERIFIED', needsConfirmation: true });
  });

  it('1-3 매월 N번째 요일', () => {
    // 2026-10-19 는 10월의 셋째 월요일
    const [f] = spot('매달 셋째 월요일', '09:00~18:00', '2026-10-19');
    expect(f?.evidence.step).toBe('1-3');
    expect(spot('매달 셋째 월요일', '09:00~18:00', '2026-10-12')).toHaveLength(0);
  });

  it('1-4 매주 요일', () => {
    // 실측: 가람집옹심이 `매주 화요일` · 2026-10-13 은 화요일
    const [f] = spot('매주 화요일', '10:30~20:00', '2026-10-13', '12:00', '13:00');
    expect(f).toMatchObject({ severity: 'BLOCKER', reasonCode: 'REST_DAY_CONFLICT' });
    expect(f?.evidence.step).toBe('1-4');
  });

  it('1-4 다른 요일이면 정상이다', () => {
    expect(spot('매주 화요일', '10:30~20:00', '2026-10-08', '12:00', '13:00')).toHaveLength(0);
  });

  describe('1-5 조건부 — 확정하지 않고 주의 + 확인 필요로 남긴다', () => {
    const rest = '매주 월요일 (단, 월요일이 공휴일인 경우 그 다음날 휴관)';

    it('공휴일 **다음 날**에 여지가 생긴다', () => {
      // 2026-10-05(월)은 개천절 대체공휴일. 그 다음 날 10-06(화)에 조건이 걸린다
      const [f] = spot(rest, '09:00~18:00', '2026-10-06');
      expect(f).toMatchObject({ severity: 'WARNING', reasonCode: 'REST_DAY_UNCERTAIN', needsConfirmation: true });
      expect(f?.evidence.step).toBe('1-5');
    });

    it('전날이 공휴일이 아니면 여지가 없다', () => {
      // 방문일 자체가 공휴일인지 보면 이 조건은 영영 발동하지 않는다
      expect(spot(rest, '09:00~18:00', '2026-10-13')).toHaveLength(0);
    });

    it('대상이 특정되지 않은 조건은 어느 날이든 여지가 있다', () => {
      // 실측: 속초 외옹치 바다향기로 `풍랑주의보 및 풍랑경보 발령 시`
      const [f] = spot('풍랑주의보 및 풍랑경보 발령 시', '상시 개방', '2026-10-08');
      expect(f).toMatchObject({ severity: 'WARNING', reasonCode: 'REST_DAY_UNCERTAIN' });
    });
  });

  it('1-6 연중무휴', () => {
    expect(spot('연중무휴', '09:00~18:00', '2026-10-08')).toHaveLength(0);
  });

  it('1-7 휴무 필드가 모두 비면 확인 불가다 — 정상으로 판정하지 않는다 (FR-AU-009)', () => {
    const [f] = spot('', '09:00~18:00', '2026-10-08');
    expect(f).toMatchObject({ severity: 'UNVERIFIED' });
    expect(f?.evidence.step).toBe('1-7');
  });

  it('순서가 곧 우선순위다 — 고정일이 요일보다 먼저다', () => {
    // 2026-01-01 은 목요일. 두 조건이 다 걸리지만 1-1 이 먼저 잡는다
    const [f] = spot('1월 1일 / 매주 목요일', '09:00~18:00', '2026-01-01');
    expect(f?.evidence.step).toBe('1-1');
  });

  it('DR-NM-021 — 닫힌 날에는 시각 판정을 하지 않는다', () => {
    // 휴무일이면서 운영시간도 벗어난 방문. finding 은 휴무 하나만 나와야 한다
    const found = spot('매주 화요일', '09:00~18:00', '2026-10-13', '20:00', '21:00');
    expect(found).toHaveLength(1);
    expect(found[0]?.reasonCode).toBe('REST_DAY_CONFLICT');
  });
});

describe('[2단계] 운영시간 선택 — 구체성이 높은 것이 이긴다', () => {
  const raw = {
    restdate: '연중무휴',
    usetime: '[월요일]- 07:40~16:00[수요일~일요일]- 07:40~19:30',
  };

  it('2-1 요일별을 먼저 본다', () => {
    // 월요일 16:30 방문 → 월요일 운영 종료 16:00 초과 → 차단
    const [f] = evaluate({ contentTypeId: 12, raw, date: '2026-10-05', start: '16:30', end: '17:00' });
    expect(f).toMatchObject({ severity: 'BLOCKER', reasonCode: 'OPEN_HOUR_CONFLICT' });
    expect(f?.evidence.source).toBe('dayOfWeekHours');
  });

  it('같은 시각이라도 요일이 다르면 판정이 다르다', () => {
    // 수요일 16:30 은 19:30 까지 운영이라 정상
    expect(evaluate({ contentTypeId: 12, raw, date: '2026-10-07', start: '16:30', end: '17:00' })).toHaveLength(0);
  });

  it('2-2 요일별이 없으면 계절별을 본다', () => {
    const seasonal = {
      restdate: '연중무휴',
      usetime: '- 하절기(4월~10월) 09:00~17:30- 동절기(11월~3월) 09:00~16:30',
    };
    // 12월 17:00 방문 → 동절기 16:30 종료 초과
    const [f] = evaluate({ contentTypeId: 12, raw: seasonal, date: '2026-12-10', start: '17:00', end: '17:30' });
    expect(f?.evidence.source).toBe('seasonalHours');
    expect(f?.severity).toBe('BLOCKER');
    // 같은 시각도 하절기에는 정상
    expect(evaluate({ contentTypeId: 12, raw: seasonal, date: '2026-06-10', start: '17:00', end: '17:30' })).toHaveLength(0);
  });

  it('2-4 아무 운영시간도 없으면 확인 불가다', () => {
    const [f] = spot('연중무휴', '', '2026-10-08');
    expect(f).toMatchObject({ severity: 'UNVERIFIED' });
    expect(f?.evidence.step).toBe('2-4');
  });
});

describe('[3단계] 시각 판정 — 기대값 표 TP-02 경계 5종', () => {
  it('운영 시작 **정각** 도착은 정상이다 — 경계 포함', () => {
    // 실측: 녹색도시체험센터 09:00~18:00 · 방문 09:00~10:30
    expect(spot('연중무휴', '09:00~18:00', '2026-10-15', '09:00', '10:30')).toHaveLength(0);
  });

  it('운영 종료를 30분 넘기면 차단이다', () => {
    // 실측: 농산물도매시장 09:00~18:00 · 방문 17:30~18:30
    const [f] = spot('연중무휴', '09:00~18:00', '2026-10-17', '17:30', '18:30');
    expect(f).toMatchObject({ severity: 'BLOCKER', reasonCode: 'OPEN_HOUR_CONFLICT' });
  });

  it('시작 시각만 보면 이 케이스를 놓친다 — 방문 **구간**으로 판정한다', () => {
    // 17:30 < 18:00 이라 시작 시각만 보면 정상이 된다
    expect(spot('연중무휴', '09:00~18:00', '2026-10-17', '17:30', null)).toHaveLength(0);
    expect(spot('연중무휴', '09:00~18:00', '2026-10-17', '17:30', '18:30')).toHaveLength(1);
  });

  it('매표 마감 전 도착 · 관람 종료 전 퇴장은 정상이다', () => {
    // 실측: 오죽헌 매표 09:00~17:00 관람 09:00~18:00 · 방문 16:45~17:45
    const found = evaluate({
      contentTypeId: 14,
      raw: { restdateculture: '연중무휴', usetimeculture: '매표시간 09:00~17:00 관람시간 09:00~18:00' },
      date: '2026-10-15', start: '16:45', end: '17:45',
    });
    expect(found).toHaveLength(0);
  });

  it('마감 이후 도착은 오류다', () => {
    const [f] = evaluate({
      contentTypeId: 14,
      raw: { restdateculture: '연중무휴', usetimeculture: '매표시간 09:00~17:00 관람시간 09:00~18:00' },
      date: '2026-10-15', start: '17:10', end: '17:50',
    });
    expect(f).toMatchObject({ severity: 'ERROR', reasonCode: 'ADMISSION_CUTOFF' });
  });

  it('준비시간에 정확히 걸치면 주의다', () => {
    // 실측: 감자유원지 준비시간 15:30~17:00 · 방문 15:30~16:30
    const [f] = evaluate({
      contentTypeId: 39,
      raw: { restdatefood: '연중무휴', opentimefood: '- 11:00~20:00- 준비시간 15:30~17:00- 마지막 주문 19:30' },
      date: '2026-10-16', start: '15:30', end: '16:30',
    });
    expect(f).toMatchObject({ severity: 'WARNING', reasonCode: 'IN_BREAK_TIME' });
  });

  it('준비시간이 끝나는 시각에 시작하면 걸치지 않는다', () => {
    const found = evaluate({
      contentTypeId: 39,
      raw: { restdatefood: '연중무휴', opentimefood: '- 11:00~20:00- 준비시간 15:30~17:00- 마지막 주문 19:30' },
      date: '2026-10-16', start: '17:00', end: '18:00',
    });
    expect(found).toHaveLength(0);
  });

  it('심야 영업을 운영시간 이탈로 오판하지 않는다 (DR-NM-023)', () => {
    // 18:00~02:00 영업. 23:00 방문은 정상이다
    expect(spot('연중무휴', '18:00~02:00', '2026-10-16', '23:00', '23:59')).toHaveLength(0);
    // 낮 방문은 벗어난다
    expect(spot('연중무휴', '18:00~02:00', '2026-10-16', '13:00', '14:00')).toHaveLength(1);
  });
});

describe('[5단계] 신뢰도 게이트 (FR-AU-008)', () => {
  it('추정이면 차단을 주의로 강등하고 확인 필요 목록에 올린다', () => {
    // `연중무휴 / 매주 목요일` → DR-NM-011 ① 로 두 경로 모두 ESTIMATED
    const [f] = spot('연중무휴 / 매주 목요일', '09:00~18:00', '2026-10-08');
    expect(f).toMatchObject({ severity: 'WARNING', reasonCode: 'REST_DAY_CONFLICT', needsConfirmation: true });
    expect(f?.evidence.gatedFrom).toBe('BLOCKER');
  });

  it('확정이면 차단 그대로다', () => {
    const [f] = spot('매주 목요일', '09:00~18:00', '2026-10-08');
    expect(f).toMatchObject({ severity: 'BLOCKER', needsConfirmation: false });
    expect(f?.evidence.gatedFrom).toBeNull();
  });

  it('해석 불가 경로는 확인 불가로 강등한다', () => {
    const [f] = spot('연중무휴', '06:00~23:00※ 점포별 상이함', '2026-10-16', '05:00', '05:30');
    expect(f).toMatchObject({ severity: 'UNVERIFIED', needsConfirmation: true });
  });
});

describe('DR-NM-022 — 시설 일부 휴관은 등급과 무관하게 별도 주의다', () => {
  const oh = {
    restdateculture: '연중무휴(1월 1일/설날/추석 당일은 오죽헌만 개방, 실내 전시실 휴관)',
    usetimeculture: '매표시간 09:00~17:00 관람시간 09:00~18:00',
  };

  it('해당일이면 어느 부분이 휴관인지 메시지에 담는다', () => {
    const found = evaluate({ contentTypeId: 14, raw: oh, date: '2026-01-01', start: '10:00', end: '11:00' });
    const partial = found.find((f) => String(f.evidence.step) === 'DR-NM-022');
    expect(partial).toMatchObject({ severity: 'WARNING', needsConfirmation: true });
    expect(partial?.message).toContain('실내 전시실');
  });

  it('전체 휴무로는 판정하지 않는다 — 차단이 아니다', () => {
    const found = evaluate({ contentTypeId: 14, raw: oh, date: '2026-01-01', start: '10:00', end: '11:00' });
    expect(found.every((f) => f.severity !== 'BLOCKER')).toBe(true);
  });

  it('해당일이 아니면 아무 finding 도 없다', () => {
    // 기대값 표 TP-01 — 10/8 방문은 해당 특정일이 아니므로 감점이 없다
    expect(evaluate({ contentTypeId: 14, raw: oh, date: '2026-10-08', start: '13:30', end: '15:00' })).toHaveLength(0);
  });
});

describe('대상 제외 (FR-AU-011 · FR-RU-014)', () => {
  it('숙박(32)은 R01 대상이 아니다', () => {
    const found = evaluate({
      contentTypeId: 32,
      raw: { checkintime: '15:00', checkouttime: '11:00' },
      date: '2026-10-08', start: '17:30', end: null, itemType: 'LODGING',
    });
    expect(found).toHaveLength(0);
  });

  it('실호출 숙박 스냅샷 3건 모두 finding 이 없다', () => {
    // 회귀 정답셋 287건에 숙박이 0건이라 이 경로는 여기서만 실행된다
    for (const file of ['32_3534495.json', '32_3540781.json', '32_4074363.json']) {
      const raw = intro(file);
      const n = parseOperatingInfo({ contentTypeId: 32, raw });
      expect(n.sourceFieldNames, file).toEqual(['checkintime', 'checkouttime']);
      expect(n.openHours, file).toBeNull();
      expect(evaluate({ contentTypeId: 32, raw, date: '2026-10-08', itemType: 'LODGING' }), file).toHaveLength(0);
    }
  });

  it('축제(15)는 playtime 만 해석하고 휴무 축을 만들지 않는다', () => {
    const raw = intro('type15_695592.json');
    const n = parseOperatingInfo({ contentTypeId: 15, raw });
    expect(n.sourceFieldNames).toEqual(['playtime']);
    expect(n.weeklyClosed).toEqual([]);
    expect(n.alwaysOpen).toBe(false);
  });

  it('매칭되지 않은 항목은 판정하지 않는다 — R05 가 다룬다', () => {
    const item: AuditItem = {
      id: 9, dayNo: 1, seq: 1, date: '2026-10-13', startTime: '12:00', endTime: '13:00',
      endTimeSource: 'INPUT', lclsSystm1: null, lclsSystm2: null, lclsSystm3: null,
      itemType: 'SIGHT', placeLabel: '이름만 있는 곳', matchStatus: 'PENDING', content: null,
    };
    expect(rule.evaluate({ productId: 1, items: [item], holidays: KOREAN_HOLIDAYS, settings: DEFAULT_AUDIT_SETTINGS })).toHaveLength(0);
  });
});

describe('결정론성 (NF-MT-001)', () => {
  it('같은 입력이면 언제나 같은 판정이다', () => {
    const runs = Array.from({ length: 5 }, () =>
      spot('매주 화요일 / 1월 1일 / 설·추석 당일', '- 11:00~20:00- 준비시간 15:30~17:00', '2026-10-16', '15:45', '16:45'),
    );
    for (const r of runs) expect(r).toEqual(runs[0]);
  });

  it('규칙 메타는 계약이다', () => {
    expect(rule.code).toBe('R01');
    expect(rule.defaultSeverity).toBe('BLOCKER');
    // R01 은 외부 호출 없이 판정한다 — "외부 참고" 배지가 붙으면 안 된다
    expect(rule.requiresExternal).toBe(false);
  });
});
