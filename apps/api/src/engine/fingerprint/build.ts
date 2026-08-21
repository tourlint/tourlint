import { createHash } from 'node:crypto';
import {
  CONTENT_TYPE_ID,
  FINGERPRINT_FIELDS,
  UNIT_SEPARATOR,
  type ContentTypeId,
} from '@tourlint/shared';
import type { ContentFingerprint } from './types';

/**
 * 지문을 만들 수 없는 콘텐츠 유형.
 *
 * 우리가 다루는 유형은 7종(12·14·15·28·32·38·39)뿐이다. 그 밖의 값이 오면 조용히 빈 지문을
 * 만들지 않고 던진다 — 빈 지문은 **영원히 "변경 없음"** 으로 읽혀서 그 콘텐츠의 변경을
 * 영구히 놓치게 된다. 호출자(AuditRunner)가 콘텐츠 단위 확인 불가로 격리해야 한다.
 */
export class UnsupportedContentTypeError extends Error {
  constructor(readonly contentTypeId: number) {
    super(`지문을 만들 수 없는 contentTypeId: ${contentTypeId} (지원 ${CONTENT_TYPE_ID.join('·')})`);
    this.name = 'UnsupportedContentTypeError';
  }
}

/** 판정 필드 값이 스칼라가 아니다 — 응답 파서가 잘못됐다는 신호다. */
export class NonScalarFieldError extends Error {
  constructor(readonly field: string, value: unknown) {
    super(`판정 필드 '${field}' 가 스칼라가 아니다 (${typeof value}). 응답 파싱을 확인할 것`);
    this.name = 'NonScalarFieldError';
  }
}

export function isSupportedContentTypeId(id: number): id is ContentTypeId {
  return (CONTENT_TYPE_ID as readonly number[]).includes(id);
}

/**
 * 판정 필드 값 하나를 지문 입력 문자열로 바꾼다.
 *
 * **전처리하지 않는다** — 접두 기호 제거 · 공백 정규화 · 트림 금지 (DR-FP-004).
 * 해석하지 못한 부분의 변경도 감지해야 하기 때문이다.
 * `null`·`undefined` 는 빈 문자열로 치환하며 둘을 구분하지 않는다 (DR-FP-005).
 */
function toFieldValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new NonScalarFieldError(field, value);
}

export interface BuildContentFingerprintInput {
  readonly contentTypeId: number;
  /** 공사 응답 항목. `detailIntro2` 를 기본으로 하되 유형 15는 행사 일자를 합쳐 넘긴다 */
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * 콘텐츠 하나의 지문을 만든다.
 *
 * 입력은 `contentTypeId` 별로 **정해진 순서**의 판정 필드 원문 값을 U+001F 로 이어붙인 문자열이고,
 * 거기에 SHA-256 을 취한다 (DR-FP-002). 순서를 바꾸면 해시가 달라지므로 순서는 계약이다.
 */
export function buildContentFingerprint(input: BuildContentFingerprintInput): ContentFingerprint {
  const { contentTypeId, raw } = input;
  if (!isSupportedContentTypeId(contentTypeId)) {
    throw new UnsupportedContentTypeError(contentTypeId);
  }

  const fieldNames = FINGERPRINT_FIELDS[contentTypeId];
  const joined = fieldNames.map((f) => toFieldValue(f, raw[f])).join(UNIT_SEPARATOR);

  return { fieldNames, fieldHash: sha256Hex(joined) };
}

export interface RunFingerprintEntry {
  readonly ktoContentId: string;
  readonly fieldHash: string;
}

/**
 * 검수 실행 하나의 **대표 지문** (DR-FP-008).
 *
 * 콘텐츠별 `field_hash` 를 `kto_content_id` **오름차순(문자열 비교)** 으로 U+001F 로 이어붙인 뒤
 * 다시 SHA-256 을 취한다. 컬럼으로 저장하지 않고 조회 시점에 산출한다.
 *
 * ⚠️ 정렬은 반드시 **문자열 비교**다. 숫자로 정렬하면 `'1000' < '999'` 가 뒤집혀
 * 같은 실행이 다른 대표 지문을 낸다.
 */
export function buildRunFingerprint(entries: readonly RunFingerprintEntry[]): string {
  const seen = new Set<string>();
  for (const e of entries) {
    // DR-FP-007 — 검수 실행당 콘텐츠별 1행. 중복이 들어오면 호출자가 잘못 모은 것이다.
    if (seen.has(e.ktoContentId)) {
      throw new Error(`대표 지문 입력에 중복 contentid 가 있다: ${e.ktoContentId}`);
    }
    seen.add(e.ktoContentId);
  }

  const joined = [...entries]
    .sort((a, b) => (a.ktoContentId < b.ktoContentId ? -1 : a.ktoContentId > b.ktoContentId ? 1 : 0))
    .map((e) => e.fieldHash)
    .join(UNIT_SEPARATOR);

  return sha256Hex(joined);
}

/** 화면 표기용 축약. 앞 8자리 (UI-CM-032) */
export function shortFingerprint(hash: string): string {
  return hash.slice(0, 8);
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
