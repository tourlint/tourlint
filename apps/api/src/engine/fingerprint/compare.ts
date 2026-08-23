import type { ChangeVerdict, FingerprintSnapshot } from './types';

/**
 * 직전 지문 P 와 현재 지문 C 를 비교해 변경 여부를 판정한다.
 *
 * ```
 * P.show_flag = 1 이고 C.show_flag = 0 → 비표출 전환. 무조건 차단 (R06-b)
 * P.field_names ≠ C.field_names        → 비교 불가. 전 규칙 재판정 후 알림 없음
 * P.field_hash = C.field_hash          → 변경 없음. 직전 판정 재사용 가능
 * P.field_hash ≠ C.field_hash          → 변경 감지. 재판정 후 알림 생성
 * ```
 *
 * ⚠️ **비표출 검사를 맨 앞에 둔 것은 명세(DR-FP 6-2)와 순서가 다르다.**
 *
 * 명세는 `field_names` 불일치를 먼저 본다. 그러면 판정 필드 목록이 바뀐 실행에서는
 * 비표출 전환이 검사되기 전에 비교 불가로 끝난다. 규칙셋을 고쳐 지문 필드가 늘어난 바로
 * 그 회차에 어떤 관광지가 내려가면 놓치는 것이다.
 *
 * 그렇게 두지 않는 이유는 두 가지다.
 *   · `show_flag` 는 **지문 필드가 아니라 별도 컬럼**이다. `field_names` 가 달라도
 *     showflag 비교는 그대로 성립한다. "비교 불가" 는 해시 비교가 안 된다는 뜻이지
 *     showflag 비교까지 안 된다는 뜻이 아니다.
 *   · 비표출 전환은 **무조건 차단**이고 사유 불명 자체가 차단 근거다
 *     (FR-RU-065 · 068 · PM-NG-009 · SC-DT-009). 비교 불가라는 이유로 놓칠 수 없다.
 *
 * 비교 불가라는 사실은 `fieldNamesChanged` 로 함께 남긴다. 이슈 #13 에서 확정.
 *
 * 순수 함수다 — 시계·난수·외부 호출을 쓰지 않는다 (NF-MT-001).
 */
export function compareFingerprint(
  previous: FingerprintSnapshot | null,
  current: FingerprintSnapshot,
): ChangeVerdict {
  if (previous === null) {
    return {
      kind: 'FIRST',
      reasonCode: null,
      reaudit: false,
      notify: false,
      modifiedTimeOnly: false,
      showFlagTurnedOff: false,
      fieldNamesChanged: false,
    };
  }

  const showFlagTurnedOff = previous.showFlag === 1 && current.showFlag === 0;
  const fieldNamesChanged = !sameFieldNames(previous.fieldNames, current.fieldNames);

  // ① 비표출 전환 — 무조건 차단 (R06-b). 다른 무엇보다 먼저 본다
  if (showFlagTurnedOff) {
    return {
      kind: 'HIDDEN',
      reasonCode: 'CONTENT_HIDDEN',
      reaudit: true,
      notify: true,
      modifiedTimeOnly: false,
      showFlagTurnedOff: true,
      fieldNamesChanged,
    };
  }

  // ② 판정 필드 목록이 다르면 해시 비교가 성립하지 않는다 (DR-FP-006).
  //    실제 변경이 아니므로 알림을 만들지 않는다 — 만들면 규칙셋을 고칠 때마다
  //    전 상품에 "변경됨" 알림이 쏟아진다 (EX-MO-005).
  if (fieldNamesChanged) {
    return {
      kind: 'INCOMPARABLE',
      reasonCode: 'FINGERPRINT_INCOMPARABLE',
      reaudit: true,
      notify: false,
      modifiedTimeOnly: false,
      showFlagTurnedOff: false,
      fieldNamesChanged: true,
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
      showFlagTurnedOff: false,
      fieldNamesChanged: false,
    };
  }

  // ④ 지문이 다르면 변경 감지.
  return {
    kind: 'CHANGED',
    reasonCode: null,
    reaudit: true,
    notify: true,
    modifiedTimeOnly: false,
    showFlagTurnedOff: false,
    fieldNamesChanged: false,
  };
}

/** 순서까지 같아야 같은 목록으로 본다 — 순서가 곧 지문 입력 순서이기 때문이다. */
function sameFieldNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
