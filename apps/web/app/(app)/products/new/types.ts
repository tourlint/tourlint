// 화면 2 · 상품 등록 폼 모델 (UI-S2 · F01). 직접 입력 1차 범위.

export type Nights = 0 | 1 | 2;

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

export interface ScheduleItem {
  id: string; // 클라이언트 전용 키 (저장 시 제외)
  itemId?: number; // 서버 항목 id. 편집 화면에서만 채워진다 (FR-IN-014)
  start: string; // "09:00" · 비우면 기본 체류시간 보완 대상 (FR-IN-011)
  end: string;
  place: string;
  itemType: ItemType | ""; // "" = 미선택
}

// 일차별 항목 배열. index 0 = 1일차.
export type Schedule = ScheduleItem[][];

export function dayCount(nights: Nights): number {
  return nights + 1;
}
