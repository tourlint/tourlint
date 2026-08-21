import type { KtoOperation } from '@tourlint/shared';
import { KtoAuthError, KtoFetchError, KtoQuotaExceededError } from './kto.errors';

/**
 * 공사 응답 봉투 해석 — **실측으로 확정된 동작만** 담는다.
 *
 * 이 파일이 처리하는 함정 5가지 (EI-KT-002 ~ 006 · 018)
 *   ① 인증 실패·쿼터 초과는 JSON 이 아니라 **XML** 로 온다
 *   ② `resultCode` 가 `0000` 이 아닌 응답은 HTTP 200 이어도 실패다
 *   ③ 0건일 때 `items` 는 빈 배열이 아니라 **빈 문자열** `""` 이다
 *   ④ `items.item` 은 1건이면 **객체**, 2건 이상이면 **배열**이다
 *   ⑤ 구 코드체계 필드는 값이 있어도 읽으면 안 되고, 상세 조회에서는 아예 비어 온다
 *
 * 순수 함수다. 네트워크·시계·전역 상태에 손대지 않는다.
 */

/**
 * 구 코드체계 필드 — **읽지 않는다** (EI-KT-006).
 *
 * 지역은 `lDongRegnCd` · `lDongSignguCd`, 유형은 `contentTypeId` · `lclsSystm1/2/3` 만 쓴다.
 * "읽지 않는다" 를 규율이 아니라 **구조**로 만들기 위해 파싱 단계에서 지워 없앤다.
 * 상세 조회에서는 어차피 전부 빈 문자열로 온다 (EI-KT-018).
 */
export const LEGACY_CODE_FIELDS = ['areacode', 'sigungucode', 'cat1', 'cat2', 'cat3'] as const;

export interface KtoEnvelope {
  readonly resultCode: string;
  readonly resultMsg: string;
  /** 0건이면 빈 배열. 호출자는 `items` 형태를 신경 쓸 필요가 없다 */
  readonly items: readonly Record<string, unknown>[];
  readonly numOfRows: number | null;
  readonly pageNo: number | null;
  readonly totalCount: number | null;
}

/** 공사 XML 오류의 `returnReasonCode`. 실측·공식 문서 기준 */
const XML_QUOTA_CODES = new Set(['22']);
const XML_AUTH_CODES = new Set(['20', '30', '31', '32', '33']);

/**
 * 응답 본문 문자열 하나를 봉투로 바꾼다. 실패는 전부 `KtoError` 로 던진다.
 *
 * `rawBody` 를 오류 메시지에 담지 않는다 — 공사 원문이 로그로 새는 경로가 된다
 * (DB 명세서 6-4 누출 경로 ①).
 */
export function parseKtoResponse(
  operation: KtoOperation,
  rawBody: string,
  httpStatus: number | null = null,
): KtoEnvelope {
  const trimmed = rawBody.trimStart();

  // ① XML 오류 응답 — JSON 파싱 실패로 오인하면 원인이 영영 안 보인다 (EI-KT-002)
  if (trimmed.startsWith('<')) {
    throw xmlErrorToKtoError(operation, trimmed);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new KtoFetchError(operation, 'JSON 으로 해석할 수 없는 응답', httpStatus);
  }

  const response = pick(parsed, 'response');
  if (!isRecord(response)) {
    throw new KtoFetchError(operation, '응답에 response 봉투가 없다', httpStatus);
  }

  const header = pick(response, 'header');
  if (!isRecord(header)) {
    throw new KtoFetchError(operation, '응답에 header 가 없다', httpStatus);
  }

  const resultCode = String(header.resultCode ?? '');
  const resultMsg = String(header.resultMsg ?? '');

  // ② resultCode 는 HTTP 상태와 별개다. 200 이어도 0000 이 아니면 실패다 (EI-KT-003)
  if (resultCode !== '0000') {
    throw resultCodeToKtoError(operation, resultCode, resultMsg, httpStatus);
  }

  const body = pick(response, 'body');
  const bodyRecord = isRecord(body) ? body : {};

  return {
    resultCode,
    resultMsg,
    items: readItems(bodyRecord.items),
    numOfRows: toIntOrNull(bodyRecord.numOfRows),
    pageNo: toIntOrNull(bodyRecord.pageNo),
    totalCount: toIntOrNull(bodyRecord.totalCount),
  };
}

/**
 * ③④ `items` 를 언제나 배열로 편다.
 *
 *   0건    → `items: ""`            (빈 배열이 아니다)
 *   1건    → `items.item: {…}`      (객체다)
 *   2건 이상 → `items.item: [{…}]`
 */
function readItems(items: unknown): readonly Record<string, unknown>[] {
  // ③ 0건 — 빈 문자열 · null · undefined 를 모두 0건으로 본다 (EI-KT-004)
  if (items === '' || items === null || items === undefined) return [];

  // 방어적: 봉투 없이 배열이 바로 오는 형태
  if (Array.isArray(items)) return items.filter(isRecord).map(stripLegacyCodeFields);

  if (!isRecord(items)) return [];

  const item = items.item;
  if (item === '' || item === null || item === undefined) return [];

  // ④ 1건이면 객체다 (EI-KT-005)
  if (isRecord(item)) return [stripLegacyCodeFields(item)];
  if (Array.isArray(item)) return item.filter(isRecord).map(stripLegacyCodeFields);

  return [];
}

/** ⑤ 구 코드체계 필드를 제거한다. 없는 필드는 실수로도 읽을 수 없다 (EI-KT-006) */
export function stripLegacyCodeFields(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    if ((LEGACY_CODE_FIELDS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * XML 오류를 사유코드로 확정한다.
 *
 * 본문 전체를 담지 않고 `returnReasonCode` 와 인증 메시지만 뽑는다.
 */
function xmlErrorToKtoError(operation: KtoOperation, xml: string): KtoFetchError | KtoAuthError | KtoQuotaExceededError {
  const code = matchTag(xml, 'returnReasonCode');
  const detail = matchTag(xml, 'returnAuthMsg') ?? matchTag(xml, 'errMsg') ?? 'XML 오류 응답';

  if (code !== null && XML_QUOTA_CODES.has(code)) {
    return new KtoQuotaExceededError(operation, code, detail);
  }
  if (code !== null && XML_AUTH_CODES.has(code)) {
    return new KtoAuthError(operation, code, detail);
  }
  // 한도·인증 메시지가 코드 없이 오는 경우까지 잡는다
  if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS/i.test(detail)) {
    return new KtoQuotaExceededError(operation, code, detail);
  }
  if (/SERVICE_KEY|ACCESS_DENIED|DEADLINE|UNREGISTERED_IP|UNSIGNED/i.test(detail)) {
    return new KtoAuthError(operation, code, detail);
  }
  return new KtoFetchError(operation, `XML 오류 응답 (${code ?? '코드없음'}): ${detail}`);
}

/** `resultCode` 도 XML 과 같은 코드 체계를 쓴다 — 한도·인증은 같은 사유코드로 모은다 */
function resultCodeToKtoError(
  operation: KtoOperation,
  resultCode: string,
  resultMsg: string,
  httpStatus: number | null,
): KtoFetchError | KtoAuthError | KtoQuotaExceededError {
  const bare = resultCode.replace(/^0+/, '') || resultCode;
  if (XML_QUOTA_CODES.has(bare)) return new KtoQuotaExceededError(operation, resultCode, resultMsg);
  if (XML_AUTH_CODES.has(bare)) return new KtoAuthError(operation, resultCode, resultMsg);
  return new KtoFetchError(operation, `resultCode ${resultCode}: ${resultMsg}`, httpStatus, resultCode);
}

function matchTag(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>\\s*([^<]*)\\s*</${tag}>`, 'i').exec(xml);
  return m?.[1]?.trim() || null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pick(v: unknown, key: string): unknown {
  return isRecord(v) ? v[key] : undefined;
}

/** 공사는 숫자 필드를 문자열로 주기도 한다 */
function toIntOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
