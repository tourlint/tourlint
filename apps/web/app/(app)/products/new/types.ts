// 화면 2 · 상품 등록 폼 모델 (UI-S2 · F01). 직접 입력 1차 범위.

export type Nights = 0 | 1 | 2;

// 박수는 자유 입력이 아니라 선택형이다 (SC-PD-001).
export const NIGHTS_OPTIONS: { value: Nights; label: string }[] = [
  { value: 0, label: "당일" },
  { value: 1, label: "1박 2일" },
  { value: 2, label: "2박 3일" },
];

export type Transport = "car" | "charter" | "public" | "walk" | "etc";

export const TRANSPORT_OPTIONS: { value: Transport; label: string }[] = [
  { value: "car", label: "자가용" },
  { value: "charter", label: "전세버스" },
  { value: "public", label: "대중교통" },
  { value: "walk", label: "도보" },
  { value: "etc", label: "기타" },
];

export interface CodeItem {
  code: string;
  name: string;
}

export interface ScheduleItem {
  id: string; // 클라이언트 전용 키 (저장 시 제외)
  start: string; // "09:00" · 비우면 기본 체류시간 보완 대상 (FR-IN-011)
  end: string;
  place: string;
  kind: string; // lcls 분류 코드
}

// 일차별 항목 배열. index 0 = 1일차.
export type Schedule = ScheduleItem[][];

export function dayCount(nights: Nights): number {
  return nights + 1;
}
