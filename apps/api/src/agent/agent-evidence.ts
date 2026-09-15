/**
 * 에이전트 출력 검증 — **그 실행의 도구 결과에 없던 값은 버린다** (FR-AG-003 · EI-LM-008 · EX-AG-003).
 *
 * 도구가 모델에게 결과를 돌려줄 때 그 안의 식별자 · 전화번호를 여기에 적어 두고, 모델의 최종 답을
 * 받은 뒤 답의 값이 여기 있는지 본다. 모델이 지어낸 contentid 로 사람이 [이곳으로 선택]을 누르면
 * 일정이 엉뚱한 곳에 묶인다 — 모르는 값은 모른다고 두는 것이 설계 원칙 3 이다.
 *
 * 값만 담고 문장 · 도구 결과 원문은 담지 않는다. 실행이 끝나면 버려진다(저장 · 로그 없음, FR-AG-004).
 */

export const EVIDENCE_KIND = ['contentId', 'findingId', 'notificationId', 'productId', 'phone'] as const;
export type EvidenceKind = (typeof EVIDENCE_KIND)[number];

/** 전화번호로 읽을 모양. 지역번호 · 휴대전화 · 대표번호(1588-0000) */
const PHONE_RE = /(?:0\d{1,2}[-.\s)]*\d{3,4}[-.\s]*\d{4}|1\d{3}[-.\s]*\d{4})/g;

export class AgentEvidence {
  private readonly seen = new Map<EvidenceKind, Set<string>>();

  /** 도구 결과에 나온 값을 적는다. 비어 있거나 모양이 아니면 적지 않는다 */
  add(kind: EvidenceKind, value: unknown): void {
    const key = normalize(kind, value);
    if (key === null) return;
    const set = this.seen.get(kind) ?? new Set<string>();
    set.add(key);
    this.seen.set(kind, set);
  }

  /** 문장 속 전화번호를 모두 적는다. 소개정보 문의처는 「033-640-4471 (강릉시청 관광과)」처럼 온다 */
  addPhonesFrom(text: unknown): void {
    if (typeof text !== 'string') return;
    for (const match of text.matchAll(PHONE_RE)) this.add('phone', match[0]);
  }

  has(kind: EvidenceKind, value: unknown): boolean {
    const key = normalize(kind, value);
    return key !== null && (this.seen.get(kind)?.has(key) ?? false);
  }

  /**
   * 항목의 값이 **모두** 도구 결과에 있을 때만 남긴다. 버린 건수를 함께 돌려준다 — 로그에는
   * 이 건수만 남긴다(EX-AG-003).
   */
  keep<T>(
    items: readonly T[],
    valuesOf: (item: T) => readonly (readonly [EvidenceKind, unknown])[],
  ): { readonly kept: readonly T[]; readonly dropped: number } {
    const kept = items.filter((item) => valuesOf(item).every(([kind, value]) => this.has(kind, value)));
    return { kept, dropped: items.length - kept.length };
  }

  /**
   * 전화번호는 항목을 버리지 않고 `null` 로 바꾼다 — 곳과 질문은 쓸 수 있고, 번호만 짐작이면 안
   * 된다(EX-AG-003 · 005). 도구 결과에 있던 번호면 모델이 쓴 모양 그대로 돌려준다.
   */
  phoneOrNull(value: unknown): string | null {
    return typeof value === 'string' && this.has('phone', value) ? value : null;
  }
}

function normalize(kind: EvidenceKind, value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  if (kind !== 'phone') return raw;
  // 하이픈 · 괄호 · 띄어쓰기는 같은 번호다. 숫자만 비교한다
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 8 ? digits : null;
}
