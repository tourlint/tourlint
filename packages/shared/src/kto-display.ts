/**
 * 공사 원문을 화면 · 리포트에 적을 때 (UI-S3-012 · UI-ST-005 · FR-CM-012).
 *
 * 판단 근거 칸과 리포트 PDF 가 같은 말을 써야 해서 여기 둔다 — 두 벌이면 한쪽만 고쳐진다.
 */

/** 원문에 실제로 섞여 오는 줄바꿈 태그 — 강릉 동부시장 `06:00~23:00<br>※ 점포별 상이함` (파싱규칙 §5) */
const BR_TOKEN = /<br\s*\/?>/gi;

/**
 * 원문의 `<br>` · `<br/>` · `<br />` 만 줄바꿈으로 되돌린다. 다른 태그는 손대지 않는다 —
 * 화면은 React 가, PDF 는 pdfkit 이 글자 그대로 찍으므로 이스케이프가 먼저 된 셈이고,
 * 복원하는 토큰은 `br` 하나뿐이다 (UI-S3-012). 원문의 나머지 글자는 한 자도 고치지 않는다.
 */
export function ktoRawText(raw: string): string {
  return raw.replace(BR_TOKEN, '\n');
}

/** 원문을 못 읽은 까닭 두 갈래 — 조회 실패 / 정보 없음(데이터 결측) (UI-ST-005) */
export type UnavailableKind = 'FETCH_FAILED' | 'NO_DATA';

/** `CONTENT_NOT_FOUND` 는 관광정보에 그 곳이 없는 것이고, 나머지 사유코드는 조회가 실패한 것이다 */
export function unavailableKind(reasonCode: string): UnavailableKind {
  return reasonCode === 'CONTENT_NOT_FOUND' ? 'NO_DATA' : 'FETCH_FAILED';
}

/** 사유코드를 화면에 찍지 않고 사용자 말로 (FR-CM-012 · UI-CM-040) */
export function unavailableText(reasonCode: string): string {
  return unavailableKind(reasonCode) === 'NO_DATA'
    ? '정보 없음 — 관광정보에 이 곳의 정보가 없습니다.'
    : '조회 실패 — 관광정보를 불러오지 못했습니다.';
}
