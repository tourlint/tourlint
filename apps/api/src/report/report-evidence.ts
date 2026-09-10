import type { ContentTypeId } from '@tourlint/shared';
import { isSupportedContentTypeId } from '../engine/fingerprint';
import { fetchContentView, type KtoClient } from '../external/kto';
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
 * API 설계 5-12 표가 리포트를 8콜로 적어 뒀던 것을 「콘텐츠 수 × 2」로 정정했다 (v1.9).
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
  return fetchContentView({
    kto,
    ktoContentId: fp.ktoContentId,
    contentTypeId: isSupportedContentTypeId(fp.contentTypeId) ? (fp.contentTypeId as ContentTypeId) : null,
    showFlag: fp.showFlag,
    ktoModifiedTime: fp.ktoModifiedTime,
  });
}
