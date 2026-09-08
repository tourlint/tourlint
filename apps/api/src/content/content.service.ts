import { CONTENT_TYPE_ID, type ContentTypeId } from '@tourlint/shared';
import { fetchContentView, type KtoClient } from '../external/kto';

/**
 * 관광지 1건 실시간 조회 (API 설계 4-2 · 5-12 · DR-PR-004 · FR-IN-030).
 *
 * **DB 에서 읽지 않는다.** 공사 원문은 저장하지 않으므로 화면이 필요한 순간 여기로 온다 —
 * finding 카드의 「판단 근거 보기」 펼침(FR-AU-013 · 061)과 확인 필요 목록의 항목 펼침
 * (FR-AU-081 · 082)이 같은 경로를 쓴다.
 */
export class ContentService {
  constructor(private readonly kto: () => KtoClient) {}

  async detail(contentId: string, contentTypeId: string | undefined): Promise<Record<string, unknown>> {
    const view = await fetchContentView({
      kto: this.kto(),
      ktoContentId: contentId,
      contentTypeId: readTypeId(contentTypeId),
    });

    return {
      contentId: view.ktoContentId,
      fetchedAt: new Date().toISOString(),
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
    };
  }
}

/** 아는 값만 받는다. 모르는 유형은 없는 것과 같이 다뤄 공통정보로 알아낸다 */
function readTypeId(raw: string | undefined): ContentTypeId | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return (CONTENT_TYPE_ID as readonly number[]).includes(n) ? (n as ContentTypeId) : null;
}
