import type { ChangeVerdict, FingerprintSnapshot } from './types';

/**
 * 직전 지문 P 와 현재 지문 C 를 비교해 변경 여부를 판정한다.
 *
 * 판정 순서는 데이터 요구사항 v1.6 §6-2 를 **그대로** 따른다.
 *
 * ```
 * P.field_names ≠ C.field_names        → 비교 불가. 전 규칙 재판정 후 알림 없음
 * P.show_flag = 1 이고 C.show_flag = 0 → 비표출 전환. 무조건 차단 (R06-b)
 * P.field_hash = C.field_hash          → 변경 없음. 직전 판정 재사용 가능
 * P.field_hash ≠ C.field_hash          → 변경 감지. 재판정 후 알림 생성
 * ```
 *
 * 순수 함수다 — 시계·난수·외부 호출을 쓰지 않는다 (NF-MT-001).
 */
export function compareFingerprint(
  previous: FingerprintSnapshot | null,
  current: FingerprintSnapshot,
): ChangeVerdict {
  // 표출 → 비표출 전환은 어떤 경로로 판정되든 호출자가 알아야 한다 (PM-NG-009 의무 조항).
  const showFlagTurnedOff = previous?.showFlag === 1 && current.showFlag === 0;

  if (previous === null) {
    return {
      kind: 'FIRST',
      reasonCode: null,
      reaudit: false,
      notify: false,
      modifiedTimeOnly: false,
      showFlagTurnedOff: false,
    };
  }

  // ① 판정 필드 목록이 다르면 비교 자체가 성립하지 않는다 (DR-FP-006).
  //    실제 변경이 아니므로 알림을 만들지 않는다 — 만들면 규칙셋을 고칠 때마다
  //    전 상품에 "변경됨" 알림이 쏟아진다 (EX-MO-005).
  if (!sameFieldNames(previous.fieldNames, current.fieldNames)) {
    return {
      kind: 'INCOMPARABLE',
      reasonCode: 'FINGERPRINT_INCOMPARABLE',
      reaudit: true,
      notify: false,
      modifiedTimeOnly: false,
      showFlagTurnedOff,
    };
  }

  // ② 비표출 전환 — 무조건 차단 (R06-b). 사유를 알 수 없다는 사실 자체가 차단 근거다.
  if (showFlagTurnedOff) {
    return {
      kind: 'HIDDEN',
      reasonCode: 'CONTENT_HIDDEN',
      reaudit: true,
      notify: true,
      modifiedTimeOnly: false,
      showFlagTurnedOff: true,
    };
  }

  // ③ 지문이 같으면 변경 없음. modifiedtime 만 달라진 경우도 여기 포함되며
  //    **판정 무관 변경**으로 분류해 알림을 만들지 않는다 (DR-FP-011).
  if (previous.fieldHash === current.fieldHash) {
    return {
      kind: 'UNCHANGED',
      reasonCode: null,
      reaudit: false,
      notify: false,
      modifiedTimeOnly: previous.ktoModifiedTime !== current.ktoModifiedTime,
      showFlagTurnedOff,
    };
  }

  // ④ 지문이 다르면 변경 감지.
  return {
    kind: 'CHANGED',
    reasonCode: null,
    reaudit: true,
    notify: true,
    modifiedTimeOnly: false,
    showFlagTurnedOff,
  };
}

/** 순서까지 같아야 같은 목록으로 본다 — 순서가 곧 지문 입력 순서이기 때문이다. */
function sameFieldNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
