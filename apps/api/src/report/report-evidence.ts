import { FINGERPRINT_FIELDS, type ContentTypeId } from '@tourlint/shared';
import { isSupportedContentTypeId } from '../engine/fingerprint';
import { isKtoError, type KtoClient } from '../external/kto';
import type { ContentEvidence } from './report-model';
import type { FingerprintRow } from './report.repository';

/**
 * 리포트용 공사 원문 재조회 (API 설계 5-12 · UI-S6-002).
 *
 * 리포트는 화면 중 유일하게 **전량 재조회**한다. 판정 내역마다 원문 근거를 병기해야 하는데
 * `finding.evidence` 에는 원문이 없기 때문이다 — 저장하지 않으니까 (DR-PR-001).
 *
 * ## 콘텐츠당 2콜이다
 *
 * `detailIntro2` 에 `title` 이 없고 `detailCommon2` 에 판정 필드가 없다(픽스처 실측).
 * 공식 명칭과 원문 근거를 둘 다 요구하므로 두 오퍼레이션이 모두 필요하다.
 * API 설계 5-12 표는 리포트를 8콜로 적었는데 8곳이면 실제로는 16콜이다 — 이슈 #35 에 적립.
 *
 * ## 실패는 콘텐츠 단위에 가둔다
 *
 * 한 곳을 못 읽어도 리포트는 나온다. 그 자리에 "조회하지 못했습니다"를 적을 뿐이다.
 * 상품 단위로 올리는 유일한 조건은 실패 50% 초과인데 그건 검수 실행의 판단이고,
 * 리포트 생성은 판정을 다시 하지 않는다.
 */

/** 관광지 단위 병렬 폭. 검수 파이프라인 2단계와 같은 기본값이다 */
export const EVIDENCE_CONCURRENCY = 8;

export interface EvidenceInput {
  readonly kto: KtoClient;
  /** 그 실행이 남긴 지문. `show_flag` 와 유형이 여기 있다 */
  readonly fingerprints: readonly FingerprintRow[];
}

/**
 * 콘텐츠별 근거를 모은다.
 *
 * 비표출(`show_flag = 0`)은 **부르지도 않는다.** 명칭·주소·이미지가 어디에도 나오면 안 되니
 * (PM-NG-009) 받아 온 뒤에 거르는 것보다 아예 안 받는 편이 새는 경로가 적다.
 */
export async function collectEvidence(input: EvidenceInput): Promise<ReadonlyMap<string, ContentEvidence>> {
  const out = new Map<string, ContentEvidence>();
  const targets = [...new Map(input.fingerprints.map((f) => [f.ktoContentId, f])).values()];

  for (let i = 0; i < targets.length; i += EVIDENCE_CONCURRENCY) {
    const batch = targets.slice(i, i + EVIDENCE_CONCURRENCY);
    const done = await Promise.all(batch.map(async (fp) => fetchOne(input.kto, fp)));
    for (const e of done) out.set(e.ktoContentId, e);
  }
  return out;
}

async function fetchOne(kto: KtoClient, fp: FingerprintRow): Promise<ContentEvidence> {
  const base = {
    ktoContentId: fp.ktoContentId,
    ktoModifiedTime: fp.ktoModifiedTime,
    officialName: null,
    imageUrl: null,
    homepageUrl: null,
    fields: [] as readonly { name: string; value: string }[],
  };

  if (fp.showFlag === 0) {
    return { ...base, ktoModifiedTime: null, hidden: true, unavailableReason: null };
  }
  if (!isSupportedContentTypeId(fp.contentTypeId)) {
    return { ...base, hidden: false, unavailableReason: 'CONTENT_NOT_FOUND' };
  }
  const typeId: ContentTypeId = fp.contentTypeId;

  /*
   * 둘 다 실패해야 확인 불가로 적는다. 하나만 실패하면 얻은 쪽은 싣는다 —
   * 명칭을 못 읽었다고 원문 근거까지 버릴 이유가 없다.
   */
  const [common, intro] = await Promise.all([
    attempt(async () => kto.detailCommon(fp.ktoContentId)),
    attempt(async () => kto.detailIntro(fp.ktoContentId, typeId)),
  ]);

  if (common.value === null && intro.value === null) {
    return { ...base, hidden: false, unavailableReason: common.reason ?? intro.reason ?? 'KTO_FETCH_FAILED' };
  }

  const c = common.value ?? {};
  const fields = FINGERPRINT_FIELDS[typeId].map((name) => ({
    name,
    value: intro.value === null ? '' : text(intro.value[name]),
  }));

  return {
    ktoContentId: fp.ktoContentId,
    officialName: blankToNull(text(c.title)),
    imageUrl: blankToNull(text(c.firstimage)),
    homepageUrl: blankToNull(firstUrl(text(c.homepage))),
    fields,
    ktoModifiedTime: fp.ktoModifiedTime,
    hidden: false,
    unavailableReason: intro.value === null ? intro.reason : null,
  };
}

interface Attempt {
  readonly value: Record<string, unknown> | null;
  readonly reason: string | null;
}

/** 공사 호출 하나. 실패는 사유코드만 남기고 삼킨다 — 원문도 URL 도 메시지에 담지 않는다 */
async function attempt(call: () => Promise<Record<string, unknown>>): Promise<Attempt> {
  try {
    return { value: await call(), reason: null };
  } catch (e) {
    if (!isKtoError(e)) throw e;
    return { value: null, reason: e.reasonCode };
  }
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v);
}

function blankToNull(s: string): string | null {
  return s === '' ? null : s;
}

/**
 * `homepage` 는 `<a href="...">...</a>` 로 오는 일이 잦다. 링크만 뽑는다 —
 * 태그째 PDF 에 박으면 읽을 수 없는 문자열이 된다.
 */
function firstUrl(raw: string): string {
  const href = /href=["']([^"']+)["']/i.exec(raw);
  if (href?.[1] !== undefined) return href[1];
  const bare = /https?:\/\/\S+/i.exec(raw);
  return bare?.[0] ?? '';
}
