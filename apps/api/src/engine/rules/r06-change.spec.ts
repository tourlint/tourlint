import { describe, expect, it } from 'vitest';
import { KOREAN_HOLIDAYS } from '../calendar/holidays';
import { compareFingerprint } from '../fingerprint';
import type { ChangeVerdict, FingerprintSnapshot } from '../fingerprint/types';
import type { NormalizedOperatingInfo } from '../normalize/types';
import { R06ChangeRule } from './r06-change';
import { DEFAULT_AUDIT_SETTINGS } from './types';
import type { AuditItem, Finding } from './types';

const rule = new R06ChangeRule();

const snap = (over: Partial<FingerprintSnapshot> = {}): FingerprintSnapshot => ({
  fieldNames: ['restdate', 'usetime'],
  fieldHash: 'a'.repeat(64),
  showFlag: 1,
  ktoModifiedTime: '20260801000000',
  ...over,
});

const normalized = { schemaVersion: '1.0' } as unknown as NormalizedOperatingInfo;

function evaluate(
  verdict: ChangeVerdict | null,
  over: { normalized?: NormalizedOperatingInfo | null; label?: string } = {},
): readonly Finding[] {
  const item: AuditItem = {
    id: 7, dayNo: 1, seq: 1, date: '2026-10-22', startTime: '10:00', endTime: '11:00',
    endTimeSource: 'INPUT', lclsSystm1: null, lclsSystm2: null, lclsSystm3: null, mapX: null, mapY: null,
    itemType: 'SIGHT', placeLabel: over.label ?? '강릉 경포대', matchStatus: 'CONFIRMED',
    content: {
      ktoContentId: '125790', contentTypeId: 12,
      normalized: over.normalized === undefined ? normalized : over.normalized,
      showFlag: 1, eventPeriod: null, changeVerdict: verdict,
    },
  };
  return rule.evaluate({ productId: 1, items: [item], holidays: KOREAN_HOLIDAYS, settings: DEFAULT_AUDIT_SETTINGS });
}

describe('R06-b 비표출 전환 — 무조건 차단 (FR-RU-065 · 068)', () => {
  const hidden = compareFingerprint(snap(), snap({ showFlag: 0 }));

  it('차단이다', () => {
    const [f] = evaluate(hidden);
    expect(f).toMatchObject({ ruleCode: 'R06', severity: 'BLOCKER', reasonCode: 'CONTENT_HIDDEN', targetItemId: 7 });
  });

  it('사유를 몰라도 완화하지 않는다', () => {
    // 사유 불명 자체가 차단 근거다 (FR-RU-068)
    const [f] = evaluate(hidden);
    expect(f?.message).toContain('사유는 알 수 없');
    expect(f?.needsConfirmation).toBe(false);
  });

  it('메시지에 관광지 명칭을 재출력하지 않는다 (FR-AU-071)', () => {
    // 이름이 우연히 안 걸리는 것을 통과로 보지 않도록 눈에 띄는 라벨을 넣는다
    const [f] = evaluate(hidden, { label: '강릉 비표출 검증소' });
    expect(f?.reasonCode).toBe('CONTENT_HIDDEN');
    expect(f?.message).not.toContain('강릉 비표출 검증소');
    // contentid 는 evidence 가 들고 있어야 어느 콘텐츠인지 짚을 수 있다
    expect(f?.evidence.ktoContentId).toBeDefined();
  });

  it('일정 항목을 지우라고 하지 않는다 — 교체 또는 제외를 안내한다 (FR-RU-066)', () => {
    const [f] = evaluate(hidden);
    expect(f?.message).toContain('교체');
    expect(f?.evidence.showFlagTurnedOff).toBe(true);
  });

  it('판정 필드까지 달라진 경우에도 비표출이 먼저다 (이슈 #13)', () => {
    const both = compareFingerprint(
      snap(),
      snap({ showFlag: 0, fieldNames: ['restdate'], fieldHash: 'b'.repeat(64) }),
    );
    const [f] = evaluate(both);
    expect(f?.severity).toBe('BLOCKER');
    // 비교 불가라는 사실도 근거에 남는다
    expect(f?.evidence.fieldNamesChanged).toBe(true);
  });
});

describe('변경 감지 자체는 finding 을 만들지 않는다 (FR-RU-061)', () => {
  it.each([
    ['FIRST', compareFingerprint(null, snap())],
    ['UNCHANGED', compareFingerprint(snap(), snap())],
    ['CHANGED', compareFingerprint(snap(), snap({ fieldHash: 'b'.repeat(64) }))],
    ['INCOMPARABLE', compareFingerprint(snap(), snap({ fieldNames: ['restdate'] }))],
  ])('%s 는 판정을 내지 않는다', (_label, verdict) => {
    // 변경은 재판정의 트리거이지 판정이 아니다. 결과는 다른 규칙들이 낸다
    expect(evaluate(verdict)).toHaveLength(0);
  });

  it('직전 지문 비교를 못 했으면 아무것도 하지 않는다', () => {
    expect(evaluate(null)).toHaveLength(0);
  });
});

describe('해석 못 한 변경은 확인 불가로 알린다 (DR-FP-012)', () => {
  const changed = compareFingerprint(snap(), snap({ fieldHash: 'b'.repeat(64) }));

  it('정규화 결과가 없으면 확인 불가다', () => {
    const [f] = evaluate(changed, { normalized: null });
    expect(f).toMatchObject({ severity: 'UNVERIFIED', needsConfirmation: true });
    expect(f?.message).toContain('해석하지 못했습니다');
  });

  it('정규화 결과가 있으면 R06 은 판정하지 않는다', () => {
    expect(evaluate(changed)).toHaveLength(0);
  });
});

describe('대상 제외', () => {
  it('매칭되지 않은 항목은 보지 않는다', () => {
    const item: AuditItem = {
      id: 9, dayNo: 1, seq: 1, date: '2026-10-22', startTime: '10:00', endTime: '11:00',
      endTimeSource: 'INPUT', lclsSystm1: null, lclsSystm2: null, lclsSystm3: null, mapX: null, mapY: null,
      itemType: 'SIGHT', placeLabel: '이름만 있는 곳', matchStatus: 'PENDING', content: null,
    };
    expect(rule.evaluate({ productId: 1, items: [item], holidays: KOREAN_HOLIDAYS, settings: DEFAULT_AUDIT_SETTINGS }))
      .toHaveLength(0);
  });

  it('규칙 메타는 계약이다', () => {
    expect(rule.code).toBe('R06');
    /*
     * **기본 등급이 없다.** 이 규칙만 등급이 하나로 정해지지 않는다 — 비표출 전환은
     * 차단이고 정규화 없이 변경만 감지한 것은 확인 불가다 (API 설계 5-10).
     * `BLOCKER` 로 적어 뒀던 것을 규칙 목록 응답을 만들며 바로잡았다.
     */
    expect(rule.defaultSeverity).toBeNull();
    // 지문 비교는 러너가 끝내고 넘긴다. 규칙은 외부를 부르지 않는다
    expect(rule.requiresExternal).toBe(false);
    expect(rule.basis).toBe('KTO_ONLY');
  });

  it('🔴 실제로 두 등급을 낸다 — 기본 등급이 null 인 근거다', () => {
    // 비표출 전환은 차단
    const hidden = evaluate(compareFingerprint(snap(), snap({ showFlag: 0 })));
    expect(hidden[0]?.severity).toBe('BLOCKER');
    // 정규화 없이 변경만 감지한 것은 확인 불가
    const unparsed = evaluate(
      compareFingerprint(snap(), snap({ fieldHash: 'b'.repeat(64) })), { normalized: null },
    );
    expect(unparsed[0]?.severity).toBe('UNVERIFIED');
    // 둘이 다르다는 것이 기본 등급을 하나로 못 적는 이유다
    expect(hidden[0]?.severity).not.toBe(unparsed[0]?.severity);
  });

  it('결정론성 (NF-MT-001)', () => {
    const v = compareFingerprint(snap(), snap({ showFlag: 0 }));
    const runs = Array.from({ length: 3 }, () => evaluate(v));
    for (const r of runs) expect(r).toEqual(runs[0]);
  });
});
