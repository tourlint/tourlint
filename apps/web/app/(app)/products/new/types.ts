// 화면 2 · 상품 등록 폼 모델 (UI-S2 · F01). 직접 입력 1차 범위.

import type { InputItemOrigin } from "@tourlint/shared";

export type Nights = 0 | 1 | 2;

/**
 * 일정을 채우는 방식 3종 (UI-S2-001). 등록 화면과 편집 화면이 같이 쓴다 — 저장한 뒤에
 * 이어서 채우는 사람도 엑셀 · 자연어로 한 번에 채울 수 있어야 한다 (#670).
 */
export type InputMethod = "direct" | "upload" | "nl";

export const INPUT_METHODS: { value: InputMethod; label: string; disabled?: boolean }[] = [
  { value: "direct", label: "직접 입력" },
  { value: "upload", label: "엑셀·CSV 업로드" },
  { value: "nl", label: "자연어 붙여넣기" },
];

// 박수는 자유 입력이 아니라 선택형이다 (SC-PD-001).
export const NIGHTS_OPTIONS: { value: Nights; label: string }[] = [
  { value: 0, label: "당일" },
  { value: 1, label: "1박 2일" },
  { value: 2, label: "2박 3일" },
];

// 이동수단은 API·DB 정본 enum 을 그대로 쓴다 (TRANSPORT — 공용 상수). R08 이동시간 판정이
// 이 값을 읽는다: CAR·CHARTER_BUS 는 지도 API, PUBLIC_TRANSIT 는 확인 불가.
export type Transport = "CAR" | "CHARTER_BUS" | "PUBLIC_TRANSIT";

export const TRANSPORT_OPTIONS: { value: Transport; label: string }[] = [
  { value: "CAR", label: "자가용" },
  { value: "CHARTER_BUS", label: "전세버스" },
  { value: "PUBLIC_TRANSIT", label: "대중교통" },
];

export interface CodeItem {
  code: string;
  name: string;
}

// 일정 항목 유형 — 엔진의 ITEM_TYPE 과 동일 (R04 집계·R07 판정이 쓴다). 관광지 분류(lcls)와
// 다른 개념이다: 분류는 관광지 확정 단계에서 붙는다.
export type ItemType = "SIGHT" | "MEAL" | "LODGING" | "REST" | "MOVE" | "FREE";

export const ITEM_TYPE_OPTIONS: { value: ItemType; label: string }[] = [
  { value: "SIGHT", label: "관광" },
  { value: "MEAL", label: "식사" },
  { value: "LODGING", label: "숙박" },
  { value: "REST", label: "휴식" },
  { value: "MOVE", label: "이동" },
  { value: "FREE", label: "자유" },
];

/** 입력하는 순간 고른 관광지 (UI-S2-020 · D8). create 계약(content)과 같은 모양이다 */
export interface MatchedContent {
  contentId: string;
  contentTypeId: number;
  mapx: number | null;
  mapy: number | null;
  lcls1: string | null;
  lcls2: string | null;
  lcls3: string | null;
}

export interface ScheduleItem {
  id: string; // 클라이언트 전용 키 (저장 시 제외)
  itemId?: number; // 서버 항목 id. 편집 화면에서만 채워진다 (FR-IN-014)
  start: string; // "09:00" · 비우면 기본 체류시간 보완 대상 (FR-IN-011)
  end: string;
  place: string;
  itemType: ItemType | ""; // "" = 미선택
  /** 장소 칸에서 고른 관광지. null = 아직 안 고름(저장 시 PENDING) (UI-S2-020) */
  content?: MatchedContent | null;
  /** 「찾는 곳이 없나요? 직접 정한 곳으로 두기」를 고른 줄 — 저장하면 직접 정한 곳(EXCLUDED) (UI-S2-021) */
  excluded?: boolean;
  /**
   * 장소 담기에서 넣은 걷기 길 (UI-S2-048 · D9). `place` 의 코스 이름은 보이기만 하고 보내지 않는다 —
   * 저장하면 직접 정한 곳으로 식별자만 남는다 (DR-MD-005)
   */
  walk?: { walkId: string };
  /** 이 줄이 들어온 경로 — 직접 입력 · 엑셀 · 메모 · 장소 담기 (FR-PL-020). 없으면 직접 입력으로 보낸다 */
  origin?: InputItemOrigin;
  /**
   * 편집 화면에서 불러온 줄의 저장값. 끝 시간을 비웠을 때 채워질 시각과 「기본값 적용」 을 엔진과 같은
   * 표로 보이는 데만 쓴다 (FR-IN-011). 저장할 때 보내지 않는다
   */
  saved?: { end: string; endTimeSource?: string; lcls2?: string | null; matchStatus: string };
}

// 일차별 항목 배열. index 0 = 1일차.
export type Schedule = ScheduleItem[][];

export function dayCount(nights: Nights): number {
  return nights + 1;
}
