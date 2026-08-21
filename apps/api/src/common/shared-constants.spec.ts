import { describe, expect, it } from 'vitest';
import {
  SEVERITY,
  SEVERITY_WEIGHT_DEFAULT,
  REASON_CODE,
  EXCEPTION_REASON_CODE,
  EXCEPTION_UNIT,
  UNPARSED_REASON,
  FINGERPRINT_FIELDS,
  INTRO_FIELDS,
  KTO_OPERATIONS,
  UNIT_SEPARATOR,
  PARSER_COVERAGE,
  RULE_CONSTANTS,
  CONTENT_TYPE_ID,
} from '@tourlint/shared';

/**
 * 공용 상수의 **건수와 값**이 명세와 어긋나지 않는지 지키는 계약 테스트.
 * 명세가 개정되면 이 테스트가 먼저 깨져야 한다 — 코드가 조용히 문서와 벌어지는 것을 막는 장치다.
 * 겸해서 apps/api 에서 @tourlint/shared 가 실제로 import 되는지도 여기서 확인된다.
 */
describe('@tourlint/shared 계약', () => {
  it('검수 등급은 4종이고 기본 가중치는 25/10/4/3이다 (FR-AU-041)', () => {
    expect(SEVERITY).toEqual(['BLOCKER', 'ERROR', 'WARNING', 'UNVERIFIED']);
    expect(SEVERITY_WEIGHT_DEFAULT).toEqual({
      BLOCKER: 25,
      ERROR: 10,
      WARNING: 4,
      UNVERIFIED: 3,
    });
  });

  it('규칙 판정 사유코드는 15종이다 (EX-CM-022)', () => {
    expect(REASON_CODE).toHaveLength(15);
    expect(new Set(REASON_CODE).size).toBe(15);
  });

  it('예외 사유코드는 39종이며 CONTENT_NOT_FOUND 를 포함한다 (예외처리 v1.3)', () => {
    expect(EXCEPTION_REASON_CODE).toHaveLength(39);
    expect(new Set(EXCEPTION_REASON_CODE).size).toBe(39);
    expect(EXCEPTION_REASON_CODE).toContain('CONTENT_NOT_FOUND');
  });

  it('판정 사유코드와 예외 사유코드는 네임스페이스가 겹치지 않는다 (EX-CM-002)', () => {
    const overlap = REASON_CODE.filter((c) =>
      (EXCEPTION_REASON_CODE as readonly string[]).includes(c),
    );
    expect(overlap).toEqual([]);
  });

  it('예외 처리 단위는 8종이다 (EX-CM-001)', () => {
    expect(EXCEPTION_UNIT).toHaveLength(8);
  });

  it('unparsed reason 은 접두어 없는 6종이다 (DR-NM 5-3)', () => {
    expect(UNPARSED_REASON).toHaveLength(6);
    expect(UNPARSED_REASON.some((r) => r.startsWith('PARSE_'))).toBe(false);
  });

  it('지문 입력 필드는 7개 유형 전부에 정의돼 있고 순서가 고정이다 (DR-FP-002)', () => {
    expect(Object.keys(FINGERPRINT_FIELDS).map(Number).sort((a, b) => a - b)).toEqual([
      ...CONTENT_TYPE_ID,
    ]);
    expect(FINGERPRINT_FIELDS[12]).toEqual(['restdate', 'usetime']);
    expect(FINGERPRINT_FIELDS[15]).toEqual(['eventstartdate', 'eventenddate', 'playtime']);
    expect(FINGERPRINT_FIELDS[32]).toEqual(['checkintime', 'checkouttime']);
  });

  it('휴무 필드가 없는 유형은 축제(15)와 숙박(32)뿐이다 (FR-AU-011 · EI-KT §3-3)', () => {
    const noRest = CONTENT_TYPE_ID.filter((id) => INTRO_FIELDS[id].rest === null);
    expect(noRest).toEqual([15, 32]);
  });

  it('유닛 구분자는 U+001F 단일 문자다 (DR-FP-002)', () => {
    expect(UNIT_SEPARATOR).toBe('\u001F');
    expect(UNIT_SEPARATOR).toHaveLength(1);
  });

  it('사용 오퍼레이션은 9종이며 폐기 예정 API 를 포함하지 않는다 (EI-KT-001)', () => {
    expect(KTO_OPERATIONS).toHaveLength(9);
    for (const banned of ['areaCode2', 'categoryCode2', 'detailInfo2']) {
      expect(KTO_OPERATIONS).not.toContain(banned);
    }
  });

  it('커버리지 통과선은 결측 제외 분모에서 도출된다 (FR-AU-004 v1.7)', () => {
    const { total, restDay, openHours, target } = PARSER_COVERAGE;
    expect(restDay.denominator).toBe(total - restDay.missing);
    expect(openHours.denominator).toBe(total - openHours.missing);
    // 통과선 = 분모 × 90% 를 넘는 최소 정수
    expect(restDay.passing).toBe(Math.floor(restDay.denominator * target) + 1);
    expect(openHours.passing).toBe(Math.floor(openHours.denominator * target) + 1);
  });

  it('판정 정의 상수는 명세 v1.6 확정값과 일치한다', () => {
    expect(RULE_CONSTANTS.R03_MIN_OVERLAP_MINUTES).toBe(1);
    expect(RULE_CONSTANTS.R08_TRAVEL_BUFFER_MINUTES).toBe(0);
    expect(RULE_CONSTANTS.R09_OUTDOOR_RATIO_THRESHOLD).toBe(0.6);
    expect(RULE_CONSTANTS.R09_FORECAST_RAIN_THRESHOLD).toBe(0.6);
    expect(RULE_CONSTANTS.R09_CLIMATE_RAIN_THRESHOLD).toBe(0.3);
  });
});
