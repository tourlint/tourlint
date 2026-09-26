// 등록 폼 → `POST /products` 본문 (API 설계 5-1). 페이지 파일은 기본 내보내기만 둘 수 있어
// 따로 두고 시험한다.

import type { PlanOrigin } from "../../../lib/api";
import type { Nights, Schedule, Transport } from "./types";

export interface PayloadInput {
  name: string;
  region: { regnCode: string; signguCode: string };
  startDate: string;
  nights: Nights;
  schedule: Schedule;
  target: string;
  concept: string;
  headcount: string;
  transport: Transport;
  planOrigin?: PlanOrigin | null;
}

export function buildPayload(f: PayloadInput) {
  // 필드명·enum 은 API 정본(설계 5-1)을 따른다. 이동수단은 공용 TRANSPORT 값을 그대로 보낸다.
  return {
    name: f.name.trim(),
    ldongRegnCd: f.region.regnCode,
    ldongSignguCd: f.region.signguCode || null,
    startDate: f.startDate,
    nights: f.nights,
    targetKey: f.target.trim() || null,
    conceptKey: f.concept.trim() || null,
    headCount: f.headcount ? Number(f.headcount) : null,
    transport: f.transport,
    planOrigin: f.planOrigin ?? null,
    days: f.schedule.map((items, i) => ({
      day: i + 1,
      items: items.map((it) => it.walk !== undefined ? {
        // 걷기 길 — 코스 식별자만 보낸다. 칸에 보이는 코스 이름은 보내지도 저장하지도 않는다 (DR-MD-005 · UI-S2-048)
        start: it.start,
        end: it.end || null,
        place: "",
        itemType: it.itemType,
        excluded: { walkId: it.walk.walkId },
        origin: it.origin ?? "PICKER",
      } : {
        start: it.start,
        end: it.end || null,
        // 관광지를 고른 줄은 칸에 보이는 이름이 공식 명칭이다 — 보내지 않는다. 서버는 저장하지 않고 표시할 때
        // 찾는다 (DR-PR-001 · DR-IN-013)
        place: it.content ? "" : it.place.trim(),
        itemType: it.itemType,
        // 입력하는 순간 고른 관광지가 있으면 저장 시 CONFIRMED 로 (UI-S2-020 · create content 계약)
        ...(it.content ? { content: it.content } : {}),
        // 「직접 정한 곳으로 두기」를 고른 줄은 EXCLUDED 로 (UI-S2-021)
        ...(it.excluded && !it.content ? { excluded: true } : {}),
        // 줄이 들어온 경로 (FR-PL-020)
        origin: it.origin ?? "MANUAL",
      }),
    })),
  };
}
