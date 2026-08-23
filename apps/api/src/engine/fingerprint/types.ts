/**
 * 검수 지문 — 무저장 변경 감지 아키텍처의 심장.
 *
 * 공사 원문을 저장하지 않으면서 "이전 상태" 를 알 수 있게 하는 유일한 장치다.
 * 지문은 **"바뀌었나"** 를 빠짐없이 감지하고, 정규화 결과는 **"무엇이 어떻게"** 를 설명한다.
 *
 * 근거: 데이터 요구사항 v1.6 §6 (DR-FP-001 ~ 012) · DB 명세서 3-7
 */

/** 한 콘텐츠의 지문. `content_fingerprint` 행의 지문 부분에 해당한다. */
export interface ContentFingerprint {
  /**
   * 지문 생성에 **사용한 필드명 목록**. 값이 아니라 이름만 담는다 (DR-FP-003).
   * 규칙 변경으로 판정 필드가 늘어나면 과거 지문과 비교 불가함을 이걸로 판별한다.
   */
  readonly fieldNames: readonly string[];
  /** SHA-256 소문자 16진 64자 (DR-FP-001) */
  readonly fieldHash: string;
}

/** 변경 감지 비교의 입력. 직전 실행과 현재 실행에서 각각 하나씩 온다. */
export interface FingerprintSnapshot {
  readonly fieldNames: readonly string[];
  readonly fieldHash: string;
  /** 1 = 표출 · 0 = 비표출 */
  readonly showFlag: 0 | 1;
  /** 원본 `YYYYMMDDHHmmss` 문자열. 비교 목적이므로 변환하지 않는다 (DR-PR-008) */
  readonly ktoModifiedTime: string;
}

export type ChangeKind =
  /** 직전 지문이 없다. 최초 검수다 */
  | 'FIRST'
  /** 판정 필드 목록이 달라 비교할 수 없다 */
  | 'INCOMPARABLE'
  /** 표출 → 비표출 전환 */
  | 'HIDDEN'
  /** 판정 필드가 그대로다 */
  | 'UNCHANGED'
  /** 판정 필드가 바뀌었다 */
  | 'CHANGED';

export interface ChangeVerdict {
  readonly kind: ChangeKind;
  /** finding·로그에 기록할 예외 사유코드. 해당 없으면 null */
  readonly reasonCode: 'FINGERPRINT_INCOMPARABLE' | 'CONTENT_HIDDEN' | null;
  /** 전 규칙을 다시 평가해야 하는가 */
  readonly reaudit: boolean;
  /** 사용자에게 알림을 만들어야 하는가 */
  readonly notify: boolean;
  /**
   * 지문은 같은데 `modifiedtime` 만 바뀐 경우.
   * **판정 무관 변경**이므로 알림을 만들지 않고 최신 조회 시각만 갱신한다 (DR-FP-011).
   */
  readonly modifiedTimeOnly: boolean;
  /**
   * 표출 → 비표출 전환이 일어났는가. **판정 종류와 무관하게 항상 채운다.**
   *
   * 명세(DR-FP 6-2)의 판정 순서상 `field_names` 불일치가 비표출 전환보다 먼저 걸리는데,
   * 비표출 노출 금지는 공사 승인 회신의 **의무 조항**(PM-NG-009 · SC-DT-009)이라
   * 어떤 경로로 판정되든 호출자가 이 사실을 놓치면 안 된다.
   */
  readonly showFlagTurnedOff: boolean;
}
