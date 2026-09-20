// 등록 화면에서 나가는 세 갈래 — 저장하고 장소 고르기 · 저장만 · 취소 (#657).
//
// 저장 수단이 「저장하고 장소 고르기」 하나뿐이라, 장소를 고를 준비가 안 된 사람은 취소로
// 나가면서 작성분을 버렸다. 그래서 상품 대시보드 「기획중」에 아무것도 남지 않았다.

import type { Nights, Schedule, Transport } from "./types";

/** 저장 뒤 갈 곳 */
export type AfterSave = "plan" | "list";

/**
 * 저장 뒤 주소. 장소 고르기로 이어 가면 그 상품의 기획 화면이고, 저장만이면 기획 목록이다.
 * 목록으로 갈 때는 상품 id 가 필요 없다 — 방금 만든 상품이 기획중으로 거기 뜬다.
 */
export function afterSaveHref(
  next: AfterSave,
  productId: number | null,
  openType: string | null,
): string {
  if (next === "list") return "/planning";
  if (productId === null) return "/";
  const suffix = openType === null ? "" : `?openType=${encodeURIComponent(openType)}`;
  return `/products/${productId}/plan${suffix}`;
}

/** 취소로 버려질 입력. 손대지 않은 빈 폼이면 묻지 않고 나간다 */
export function hasInput(f: {
  name: string;
  regnCode: string;
  startDate: string;
  nights: Nights;
  target: string;
  concept: string;
  headcount: string;
  transport: Transport;
  schedule: Schedule;
}): boolean {
  return (
    f.name.trim() !== "" ||
    f.regnCode !== "" ||
    f.startDate !== "" ||
    f.nights !== 0 ||
    f.target !== "" ||
    f.concept !== "" ||
    f.headcount.trim() !== "" ||
    f.transport !== "CAR" ||
    f.schedule.some((day) => day.length > 0)
  );
}
