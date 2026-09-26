// 일정 줄을 가리키는 한 줄 — 「1일차 09:00 · 강릉역」. 검수 시작 창의 목록과 AI 카드 줄이 같이 쓴다.
// AI 카드가 떠 있으면 편집기 줄은 「아직 고르지 않음」 만 남으므로, 카드 줄이 어느 일정 줄인지는
// 이 한 줄로 안다 — AI 가 쓴 이유 문장에 기대지 않는다. 이름은 사람이 입력한 말이다(D1).

import type { ProductItem } from "../../../../lib/api";

/** 일차가 붙을 수 있는 일정 줄. 상품 상세는 일차별로 묶여 와서 풀 때 붙인다 (`withDays`) */
export type LineItem = ProductItem & { day?: number };

export function withDays(days: readonly { day: number; items: readonly ProductItem[] }[]): (ProductItem & { day: number })[] {
  return days.flatMap((d) => d.items.map((it) => ({ ...it, day: d.day })));
}

export function lineLabel(line: { day?: number | null; start: string; place: string }): string {
  const when = [line.day == null ? null : `${line.day}일차`, line.start === "" ? null : line.start]
    .filter((s): s is string => s !== null)
    .join(" ");
  const name = line.place.trim() || "이름 없는 줄";
  return when === "" ? name : `${when} · ${name}`;
}
