import type { IndoorOutdoor, ItemMatchedBy, ItemOrigin, PlanNearKind } from './constants';

/**
 * 기획 화면 응답 모양 (API 4-10 · F17). 서버 `plan` 모듈이 만들고 화면은 이 모양만 본다.
 *
 * 제목 · 주소 · 사진 URL · 행사명 · 코스 이름은 공사 원문이라 응답으로만 흐르고 DB · 로그에
 * 남기지 않는다 (DB 명세서 6-4 · DR-PR-009). 판정 · 등급 · 규칙 번호는 두지 않는다 (FR-PL-021).
 *
 * `null` 은 "못 받았다 · 아직 안 셌다"다. 0 으로 바꿔 적지 않는다 (EX-PL-004).
 */

/** 종류 칩 한 개. 기대 · 없음 같은 판정 필드는 두지 않는다 (FR-PL-010) */
export interface PlanTypeChip {
  kind: 'LCLS2' | 'EVENT' | 'WALK' | 'NEAR';
  lcls2: string | null;
  nearKind: PlanNearKind | null;
  name: string;
  /** null = 아직 세지 않음(근처 3km) 또는 그 서비스를 못 부름 */
  count: number | null;
  disabled: 'ANCHOR_REQUIRED' | null;
}

export interface PlanBriefing {
  /** 세종(36110)은 시군구 단계가 없어 `signguCd` 가 null 이다 (FR-IN-006) */
  region: { regnCd: string; signguCd: string | null; name: string };
  /** 첫째 줄(시군구 전체)만. 근처 3km 칩은 화면이 앵커를 정한 뒤 따로 연다 */
  types: PlanTypeChip[];
  events: { count: number; from: string; to: string } | null;
  accessible: { count: number } | null;
  pet: { count: number } | null;
  walks: { count: number } | null;
  budget: 'OK' | 'WARN' | 'PAUSED';
}

export interface PlanPlace {
  contentId: string;
  contentTypeId: number;
  lcls1: string;
  lcls2: string;
  lcls2Name: string;
  /** 공사 원문 — 응답으로만 */
  title: string;
  addr1: string | null;
  firstImage: string | null;
  mapx: number | null;
  mapy: number | null;
  distanceM: number | null;
  /** 연관 관광지 순위. 관광지만, 이름 · 시군구 대조가 하나로 정해질 때만 (EI-KT-024) */
  togetherRank: number | null;
  /** null = 무장애 · 반려동물 목록을 못 받음 */
  wheelchair: boolean | null;
  pet: boolean | null;
  indoorOutdoor: IndoorOutdoor | null;
}

export interface PlanEvent {
  contentId: string;
  contentTypeId: number;
  title: string;
  eventStart: string;
  eventEnd: string;
  /** 여행 날짜와의 관계 — 참고 표시일 뿐 판정은 검수의 R02 가 한다 (FR-PL-014) */
  relation: 'BEFORE' | 'IN' | 'AFTER';
  suggestedStartDate: string | null;
  firstImage: string | null;
  mapx: number | null;
  mapy: number | null;
}

/**
 * 두루누비 걷기 길 코스 (EI-KT-025). 일정에 넣을 때는 `walkId` 만 보내고 이름은 저장하지 않는다.
 * 코스 응답에 좌표가 없어 근처 3km 칩의 기준이 되지 않는다 (2026.09.15 실호출).
 */
export interface PlanWalk {
  walkId: string;
  name: string;
  lengthKm: number | null;
  minutes: number | null;
  /** 두루누비 난이도 값 그대로 */
  level: 1 | 2 | 3 | null;
}

/** 장소 정보 한 줄 — 고른 항목의 사실만 보인다. 규칙 판정 없음 (FR-PL-005) */
export interface PlaceFacts {
  itemId: number;
  name: string;
  kindName: string;
  /** 공사 원문 표시값 — 응답으로만 */
  hours: string | null;
  restDays: string | null;
  fee: string | null;
  parking: string | null;
  eventPeriod: string | null;
  /** 앞 항목과 양쪽 좌표가 있을 때만 */
  travelFromPrevMinutes: number | null;
  matchedBy: ItemMatchedBy | null;
  origin: ItemOrigin | null;
}
