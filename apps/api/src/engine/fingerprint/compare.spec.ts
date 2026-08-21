import { describe, expect, it } from 'vitest';
import { compareFingerprint } from './compare';
import type { FingerprintSnapshot } from './types';

const FIELDS = ['restdate', 'usetime'] as const;
const snap = (over: Partial<FingerprintSnapshot> = {}): FingerprintSnapshot => ({
  fieldNames: [...FIELDS],
  fieldHash: 'a'.repeat(64),
  showFlag: 1,
  ktoModifiedTime: '20260814103000',
  ...over,
});

describe('compareFingerprint (DR-FP 6-2)', () => {
  it('직전 지문이 없으면 FIRST — 재판정도 알림도 없다', () => {
    const v = compareFingerprint(null, snap());
    expect(v.kind).toBe('FIRST');
    expect(v.reaudit).toBe(false);
    expect(v.notify).toBe(false);
  });

  it('지문이 같으면 UNCHANGED — 직전 판정을 재사용할 수 있다', () => {
    const v = compareFingerprint(snap(), snap());
    expect(v.kind).toBe('UNCHANGED');
    expect(v.reaudit).toBe(false);
    expect(v.notify).toBe(false);
    expect(v.modifiedTimeOnly).toBe(false);
  });

  it('지문이 다르면 CHANGED — 재판정하고 알림을 만든다', () => {
    const v = compareFingerprint(snap(), snap({ fieldHash: 'b'.repeat(64) }));
    expect(v.kind).toBe('CHANGED');
    expect(v.reaudit).toBe(true);
    expect(v.notify).toBe(true);
  });

  it('지문은 같고 modifiedtime 만 바뀌면 판정 무관 변경 — 알림을 만들지 않는다 (DR-FP-011)', () => {
    const v = compareFingerprint(snap(), snap({ ktoModifiedTime: '20260820090000' }));
    expect(v.kind).toBe('UNCHANGED');
    expect(v.notify).toBe(false);
    // 호출자는 이 플래그를 보고 최신 조회 시각만 갱신한다.
    expect(v.modifiedTimeOnly).toBe(true);
  });

  it('field_names 가 다르면 INCOMPARABLE — 재판정하되 알림은 만들지 않는다 (DR-FP-006 · EX-MO-005)', () => {
    // 알림을 만들면 규칙셋을 고칠 때마다 전 상품에 "변경됨"이 쏟아진다. 실제 변경이 아니다.
    const v = compareFingerprint(snap(), snap({ fieldNames: ['restdate', 'usetime', 'playtime'] }));
    expect(v.kind).toBe('INCOMPARABLE');
    expect(v.reasonCode).toBe('FINGERPRINT_INCOMPARABLE');
    expect(v.reaudit).toBe(true);
    expect(v.notify).toBe(false);
  });

  it('field_names 는 순서까지 같아야 한다 — 순서가 곧 지문 입력 순서다', () => {
    const v = compareFingerprint(snap(), snap({ fieldNames: ['usetime', 'restdate'] }));
    expect(v.kind).toBe('INCOMPARABLE');
  });

  it('표출 → 비표출 전환이면 HIDDEN — 무조건 차단이다 (R06-b)', () => {
    const v = compareFingerprint(snap({ showFlag: 1 }), snap({ showFlag: 0 }));
    expect(v.kind).toBe('HIDDEN');
    expect(v.reasonCode).toBe('CONTENT_HIDDEN');
    expect(v.reaudit).toBe(true);
    expect(v.notify).toBe(true);
    expect(v.showFlagTurnedOff).toBe(true);
  });

  it('지문이 그대로여도 비표출로 바뀌면 HIDDEN 이다 — 원문 변경과 무관한 사건이다', () => {
    const v = compareFingerprint(snap({ showFlag: 1 }), snap({ showFlag: 0 }));
    expect(v.kind).toBe('HIDDEN');
  });

  it('계속 비표출이거나 비표출 → 표출 복귀는 HIDDEN 이 아니다', () => {
    expect(compareFingerprint(snap({ showFlag: 0 }), snap({ showFlag: 0 })).kind).toBe('UNCHANGED');
    expect(compareFingerprint(snap({ showFlag: 0 }), snap({ showFlag: 1 })).kind).toBe('UNCHANGED');
  });

  it('field_names 불일치가 비표출 전환보다 먼저 걸려도 showFlagTurnedOff 는 남는다', () => {
    // 명세(6-2)의 판정 순서상 INCOMPARABLE 이 먼저 걸린다. 그런데 비표출 노출 금지는
    // 공사 승인 회신의 의무 조항(PM-NG-009)이라 호출자가 이 사실을 놓치면 안 된다.
    const v = compareFingerprint(
      snap({ showFlag: 1 }),
      snap({ showFlag: 0, fieldNames: ['restdate'] }),
    );
    expect(v.kind).toBe('INCOMPARABLE');
    expect(v.showFlagTurnedOff).toBe(true);
  });

  it('같은 입력이면 언제나 같은 판정이다 (NF-MT-001)', () => {
    const p = snap();
    const c = snap({ fieldHash: 'b'.repeat(64), ktoModifiedTime: '20260820090000' });
    const results = Array.from({ length: 5 }, () => JSON.stringify(compareFingerprint(p, c)));
    expect(new Set(results).size).toBe(1);
  });
});
