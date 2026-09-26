import { useEffect, useState } from "react";
import { planApi, type Patch, type PlanPlaceDetail, type ProductDetail, type ProductItem } from "../../../lib/api";
import { shownPlace } from "../../../lib/place-label";

type ScheduleItem = ProductItem & { day: number };
interface Change { place: string; context?: string; before: string; after: string }
interface Description { action: string; changes: Change[]; note?: string }
const TYPE_LABEL: Record<string, string> = { SIGHT: "관광", MEAL: "식사", REST: "휴식", LODGING: "숙박", MOVE: "이동", FREE: "자유" };

function time(start?: string | null, end?: string | null): string {
  return `${start === undefined ? "시작 확인 불가" : start || "시작 미입력"} – ${end === undefined ? "종료 확인 불가" : end || "종료 미입력"}`;
}
function when(day: number | undefined, start?: string | null, end?: string | null): string {
  return `${day === undefined ? "일차 확인 불가" : `${day}일차`} · ${time(start, end)}`;
}
function identity(item: ScheduleItem | undefined, id: number): Pick<Change, "place" | "context"> {
  return {
    place: item ? (shownPlace(item) ?? `${TYPE_LABEL[item.itemType] ?? "장소"} (이름 미입력)`) : `일정 #${id}`,
    context: item ? `${item.day}일차 · ${item.seq}번째 일정` : "현재 항목 확인 불가",
  };
}
function current(item: ScheduleItem | undefined): string {
  return item ? when(item.day, item.start, item.end) : "현재 일정 확인 불가";
}

/**
 * 대체 장소가 어디서 얼마나 떨어져 있는지 (#728).
 *
 * 「대체 장소까지 약 0.4km」 만으로는 어디서부터인지 알 수 없다. 이동시간 수정안은 **앞 일정**
 * 에서 찾으므로 그 이름을 적고, 그 밖에는 바꾸기 전 장소에서 잰 거리다.
 */
function distanceNote(meters: number | undefined, fromItemId: number | undefined, items: ScheduleItem[]): string {
  if (meters === undefined) return "";
  const distance = meters < 1000 ? `${Math.round(meters / 10) * 10}m` : `${Math.round(meters / 100) / 10}km`;
  if (fromItemId === undefined) return `지금 장소에서 약 ${distance} · `;
  const from = items.find(it => it.itemId === fromItemId)?.place.trim();
  return `앞 일정${from ? ` ${from}` : ""}에서 약 ${distance} · `;
}

/** 변경 대상은 finding의 첫 장소가 아닌 각 patch.targetItemId다. 적용 전 현재 일정 기준이다. */
export function describePatch(patch: Patch, product: Pick<ProductDetail, "days"> | null): Description {
  const items = product?.days.flatMap(d => d.items.map(it => ({ ...it, day: d.day }))) ?? [];
  const target = items.find(it => it.itemId === patch.targetItemId);
  const p = patch.payload;
  const base = identity(target, patch.targetItemId);
  switch (patch.type) {
    case "TIME_SHIFT":
      return {
        action: p.newDayNo !== undefined ? "방문 일차·시간 변경" : "방문 시간 변경",
        changes: [{ ...base, before: current(target), after: when(p.newDayNo ?? target?.day, p.newStartTime ?? target?.start, p.newEndTime ?? target?.end) }],
        // 이동시간을 몰라 겹침만 푼 안이다 — 반영 뒤 재검수가 이동을 다시 본다 (FR-RU-033 · #877)
        note: !target
          ? "대상 일정을 확인한 뒤 미리보기에서 변경 내용을 확인해 주세요."
          : p.travelUnchecked ? "이동시간을 확인하지 못해 겹침만 풀었어요. 반영 후 다시 검수해 확인해요." : undefined,
      };
    case "REORDER": {
      const other = items.find(it => it.itemId === p.swapWithItemId);
      // 다른 날 일정과 맞바꾸면 일차도 바뀐다 — R01 휴무 충돌의 순서 교체 (FR-RU-013 ② · #877)
      const crossDay = target !== undefined && other !== undefined && target.day !== other.day;
      return {
        action: crossDay ? "두 장소의 방문 일차·시간 교환" : "두 장소의 방문 순서·시간 교환",
        changes: [
          { ...base, before: current(target), after: other ? when(other.day, other.start, other.end) : "상대 일정 확인 불가" },
          { ...identity(other, p.swapWithItemId ?? patch.targetItemId), before: current(other), after: target ? when(target.day, target.start, target.end) : "상대 일정 확인 불가" },
        ],
      };
    }
    case "REPLACE_CONTENT":
      return {
        action: "방문 장소 교체",
        changes: [{ ...base, before: base.place, after: patch.placeName ?? "대체 장소 이름 확인 불가" }],
        note: `${distanceNote(p.distanceMeters, p.fromItemId, items)}방문 일차·시간은 유지됩니다.`,
      };
    case "INSERT_ITEM":
      return {
        action: `${TYPE_LABEL[p.itemType ?? ""] ?? "일정"} 추가`,
        changes: [{ place: patch.placeName ?? `${TYPE_LABEL[p.itemType ?? ""] ?? "새 일정"} 시간`, before: "새 일정", after: when(p.dayNo, p.startTime, p.endTime) }],
      };
    case "REMOVE_ITEM":
      return { action: "방문 삭제", changes: [{ ...base, before: current(target), after: "이 장소를 일정에서 삭제" }] };
  }
}

export function PatchDescription({ patch, product, selected = false }: {
  patch: Patch;
  product: Pick<ProductDetail, "days"> | null;
  /** 고른 대체 장소만 운영 조건을 부른다 — 후보마다 부르면 조회가 곱절이 된다 (UI-S3-016 · #880) */
  selected?: boolean;
}) {
  const description = describePatch(patch, product);
  return <span className="min-w-0 flex-1 text-slate-700 dark:text-slate-300">
    <span className="block text-xs font-semibold text-emerald-700 dark:text-emerald-300">{description.action}</span>
    {description.changes.map((change, i) => <span key={i} className="mt-2 block">
      <strong className="block break-words text-sm">{change.place}</strong>
      {change.context && <span className="mt-0.5 block text-xs text-slate-500">{change.context}</span>}
      <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-relaxed">
        <span><span className="text-slate-500">현재 </span>{change.before}</span>
        <span aria-hidden="true">→</span>
        <span className="rounded bg-white/80 px-2 py-1 font-medium dark:bg-slate-900"><span className="text-emerald-700 dark:text-emerald-300">변경 후 </span>{change.after}</span>
      </span>
    </span>)}
    {description.note && <span className="mt-2 block text-xs text-slate-500">{description.note}</span>}
    {selected && patch.type === "REPLACE_CONTENT" && <ReplacementConditions patch={patch} />}
  </span>;
}

/**
 * 고른 대체 장소의 운영 조건 — 쉬는 날 · 이용시간(행사면 기간) (UI-S3-016 · #880).
 *
 * 수정안에는 공사 원문을 담지 않는다(DR-PR-001). 고를 때 장소 「자세히」 와 같은 조회로 그곳 하나만
 * 부르고 저장하지 않는다. 못 받으면 그렇다고 적는다 — 고르는 데는 지장이 없다.
 */
function ReplacementConditions({ patch }: { patch: Patch }) {
  const id = patch.payload.ktoContentId;
  const type = patch.payload.contentTypeId;
  const [detail, setDetail] = useState<PlanPlaceDetail | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (id === undefined || type === undefined) return;
    let alive = true;
    planApi.placeDetail(id, type)
      .then((d) => { if (alive) setDetail(d); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [id, type]);

  if (id === undefined || type === undefined) return null;
  const rows: [string, string | null][] = detail === null ? [] : [
    ["쉬는 날", detail.restDays],
    ["이용시간", detail.hours],
    ["행사 기간", detail.eventPeriod],
  ];
  const shown = rows.filter(([, v]) => v !== null && v.trim() !== "");
  return <span className="mt-2 block rounded bg-slate-50 px-2 py-1.5 text-xs text-slate-600 dark:bg-slate-900/60 dark:text-slate-300" data-replacement-conditions>
    {failed ? "운영 정보를 불러오지 못했어요."
      : detail === null ? "운영 정보를 불러오는 중…"
        : shown.length === 0 ? "관광정보에 올라 있는 이용 정보가 없어요."
          : shown.map(([label, value]) => <span key={label} className="block"><span className="text-slate-400">{label}</span> <span className="whitespace-pre-line">{value}</span></span>)}
  </span>;
}
