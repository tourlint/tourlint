import { FINGERPRINT_FIELDS, INTRO_FIELDS, type ContentTypeId } from '@tourlint/shared';
import { isKtoError, type KtoClient } from './index';

/**
 * 관광지 1건의 **표시용 조달** (API 설계 5-12 · DR-PR-004).
 *
 * 공사 원문은 저장하지 않으므로 화면과 리포트가 필요한 순간에 부른다. 리포트의 전량
 * 재조회와 근거 펼침 1건이 같은 코드를 쓰도록 여기 둔다 — 두 벌이면 한쪽만 고쳐진다.
 *
 * ## 콘텐츠당 2콜이다
 *
 * `detailIntro2` 에 `title` · `homepage` 가 없고 `detailCommon2` 에 판정 필드가 없다
 * (픽스처 실측). 문의처는 더 갈린다 — `infocenter` 계열은 소개정보에, 폴백인 `tel` 은
 * 공통정보에 있어 **둘 다 봐야 한다** (FR-AU-017).
 */

export interface ContentView {
  readonly ktoContentId: string;
  /** 공식 명칭. 못 읽었거나 비표출이면 `null` — 지어내지 않는다 */
  readonly officialName: string | null;
  /** 원본 이미지 URL. 임베드하지 않는다 (FR-PA-063) */
  readonly imageUrl: string | null;
  readonly homepageUrl: string | null;
  /** 문의처. 없으면 `null` 이고 화면이 "정보 없음" 을 적는다 (FR-AU-082 · EX-PS-010) */
  readonly contact: { readonly tel: string | null };
  /** 판정 필드 원문. `FINGERPRINT_FIELDS` 순서 그대로 */
  readonly fields: readonly { readonly name: string; readonly value: string }[];
  /** 원본 `YYYYMMDDHHmmss`. 변환하지 않는다 (DR-PR-008) */
  readonly ktoModifiedTime: string | null;
  /** 비표출(`show_flag = 0`). 참이면 명칭 · 주소 · 이미지를 싣지 않는다 (PM-NG-009) */
  readonly hidden: boolean;
  /** 조회 실패 사유코드. 성공이면 `null` */
  readonly unavailableReason: string | null;
}

export interface ContentViewInput {
  readonly kto: KtoClient;
  readonly ktoContentId: string;
  /** 아는 경우 넘긴다. 없으면 공통정보를 먼저 읽어 알아낸다 */
  readonly contentTypeId: ContentTypeId | null;
  /** 지문이 있으면 비표출 여부를 이미 안다. 없으면 조회한다 */
  readonly showFlag?: number | null;
  readonly ktoModifiedTime?: string | null;
}

export function isSupportedContentTypeId(v: number | null): v is ContentTypeId {
  return v !== null && v in FINGERPRINT_FIELDS;
}

/**
 * 한 건을 읽는다.
 *
 * **비표출이면 부르지도 않는다.** 명칭·주소·이미지가 어디에도 나오면 안 되니
 * (PM-NG-009) 받아 온 뒤 거르는 것보다 아예 안 받는 편이 새는 경로가 적다.
 *
 * 둘 다 실패해야 확인 불가로 적는다. 하나만 실패하면 얻은 쪽은 싣는다 — 명칭을
 * 못 읽었다고 원문 근거까지 버릴 이유가 없다.
 */
export async function fetchContentView(input: ContentViewInput): Promise<ContentView> {
  const base = {
    ktoContentId: input.ktoContentId,
    officialName: null,
    imageUrl: null,
    homepageUrl: null,
    contact: { tel: null },
    fields: [] as readonly { name: string; value: string }[],
  };
  const modifiedTime = input.ktoModifiedTime ?? null;

  if (input.showFlag === 0) {
    return { ...base, ktoModifiedTime: null, hidden: true, unavailableReason: null };
  }

  /*
   * 유형을 모르면 공통정보를 먼저 읽는다. 소개정보는 유형별로 오퍼레이션 파라미터가
   * 갈려서 유형 없이는 부를 수 없다. 아는 경우에는 둘을 나란히 낸다.
   */
  let common: Attempt;
  let typeId: ContentTypeId | null = input.contentTypeId;
  let intro: Attempt;

  if (typeId === null) {
    common = await attempt(async () => input.kto.detailCommon(input.ktoContentId));
    const read = Number(text(common.value?.contenttypeid));
    typeId = isSupportedContentTypeId(read) ? read : null;
    intro = typeId === null
      ? { value: null, reason: common.reason ?? 'CONTENT_NOT_FOUND' }
      : await attempt(async () => input.kto.detailIntro(input.ktoContentId, typeId as ContentTypeId));
  } else {
    const known = typeId;
    [common, intro] = await Promise.all([
      attempt(async () => input.kto.detailCommon(input.ktoContentId)),
      attempt(async () => input.kto.detailIntro(input.ktoContentId, known)),
    ]);
  }

  if (common.value === null && intro.value === null) {
    return {
      ...base, ktoModifiedTime: modifiedTime, hidden: false,
      unavailableReason: common.reason ?? intro.reason ?? 'KTO_FETCH_FAILED',
    };
  }

  const c = common.value ?? {};
  const fields = typeId === null ? [] : FINGERPRINT_FIELDS[typeId].map((name) => ({
    name,
    value: intro.value === null ? '' : text(intro.value[name]),
  }));

  return {
    ktoContentId: input.ktoContentId,
    officialName: blankToNull(text(c.title)),
    imageUrl: blankToNull(text(c.firstimage)),
    homepageUrl: blankToNull(firstUrl(text(c.homepage))),
    contact: { tel: readContact(typeId, intro.value, c) },
    fields,
    ktoModifiedTime: modifiedTime ?? blankToNull(text(c.modifiedtime)),
    hidden: false,
    unavailableReason: intro.value === null ? intro.reason : null,
  };
}

/**
 * 문의처 (FR-AU-017).
 *
 * 소개정보의 `infocenter` 계열이 먼저다. 비어 있으면 공통정보의 `tel` 로 넘어간다 —
 * 실측에 `tel` 이 비고 `infocentershopping` 에만 값이 있는 콘텐츠가 있었고, 그 반대도 있다.
 */
function readContact(
  typeId: ContentTypeId | null,
  intro: Record<string, unknown> | null,
  common: Record<string, unknown>,
): string | null {
  if (typeId !== null && intro !== null) {
    const field = INTRO_FIELDS[typeId].contact;
    const value = text(intro[field]);
    if (value !== '') return value;
  }
  return blankToNull(text(common.tel));
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

export function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v);
}

export function blankToNull(s: string): string | null {
  return s === '' ? null : s;
}

/**
 * `homepage` 는 `<a href="...">...</a>` 로 오는 일이 잦다. 링크만 뽑는다 —
 * 태그째 실으면 읽을 수 없는 문자열이 된다.
 */
export function firstUrl(raw: string): string {
  const href = /href=["']([^"']+)["']/i.exec(raw);
  if (href?.[1] !== undefined) return href[1];
  const bare = /https?:\/\/\S+/i.exec(raw);
  return bare?.[0] ?? '';
}
