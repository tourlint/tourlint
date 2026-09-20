import { CONTENT_TYPE_ID, type ContentTypeId, kstIso } from '@tourlint/shared';
import { fetchContentView, type KtoClient } from '../external/kto';
import type { ConditionWant, PlaceConditionService } from '../plan/place-conditions.service';

/**
 * 관광지 1건 실시간 조회 (API 설계 4-2 · 5-12 · DR-PR-004 · FR-IN-030).
 *
 * **DB 에서 읽지 않는다.** 공사 원문은 저장하지 않으므로 화면이 필요한 순간 여기로 온다 —
 * finding 카드의 「판단 근거 보기」 펼침(FR-AU-013 · 061)과 확인 필요 목록의 항목 펼침
 * (FR-AU-081 · 082)이 같은 경로를 쓴다.
 *
 * `with=accessible,pet` 을 주면 기획 화면의 카드 펼침이 쓰는 조건 축을 함께 낸다 (FR-PL-012).
 * 요청하지 않으면 부르지 않는다 — 검수 화면의 근거 보기는 지금까지와 같은 콜 수다.
 */
export class ContentService {
  constructor(
    private readonly kto: () => KtoClient,
    private readonly conditions?: PlaceConditionService,
  ) {}

  async detail(
    contentId: string,
    contentTypeId: string | undefined,
    want?: ConditionWant,
  ): Promise<Record<string, unknown>> {
    const view = await fetchContentView({
      kto: this.kto(),
      ktoContentId: contentId,
      contentTypeId: readTypeId(contentTypeId),
    });

    return {
      contentId: view.ktoContentId,
      fetchedAt: kstIso(new Date()),
      /*
       * 비표출로 전환된 콘텐츠는 명칭 · 주소 · 이미지를 내보내지 않는다
       * (PM-NG-009 · FR-AU-070 · 071). `fetchContentView` 가 애초에 부르지도 않는다.
       */
      hidden: view.hidden,
      officialName: view.officialName,
      homepageUrl: view.homepageUrl,
      contact: view.contact,
      /** 판정 필드 원문. 한 글자도 고치지 않는다 (FR-AU-061) */
      ktoRaw: Object.fromEntries(view.fields.map((f) => [f.name, f.value])),
      ktoModifiedTime: view.ktoModifiedTime,
      unavailableReason: view.unavailableReason,
      // 좌표 · 분류 · 유형 — 등록 인라인 매칭이 pick 시 잡아 저장에 싣는다 (UI-S2-020 · #513 계약)
      contentTypeId: view.contentTypeId,
      mapx: view.mapx,
      mapy: view.mapy,
      lclsSystm1: view.lclsSystm1,
      lclsSystm2: view.lclsSystm2,
      lclsSystm3: view.lclsSystm3,
      ...(await this.conditionsOf(contentId, want)),
    };
  }

  /** 요청한 축만 붙인다. 못 받으면 그 축은 `null` 이고 카드의 나머지는 그대로다 (EX-PL-004) */
  private async conditionsOf(contentId: string, want: ConditionWant | undefined): Promise<Record<string, unknown>> {
    if (want === undefined || (!want.accessible && !want.pet)) return {};
    if (this.conditions === undefined) {
      return { ...(want.accessible ? { accessible: null } : {}), ...(want.pet ? { pet: null } : {}) };
    }
    const found = await this.conditions.of(contentId, want);
    return {
      ...(want.accessible ? { accessible: found.accessible } : {}),
      ...(want.pet ? { pet: found.pet } : {}),
    };
  }
}

/** 아는 값만 받는다. 모르는 유형은 없는 것과 같이 다뤄 공통정보로 알아낸다 */
function readTypeId(raw: string | undefined): ContentTypeId | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return (CONTENT_TYPE_ID as readonly number[]).includes(n) ? (n as ContentTypeId) : null;
}
