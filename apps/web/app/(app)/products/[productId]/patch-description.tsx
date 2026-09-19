import type { Patch, ProductDetail, ProductItem } from "../../../lib/api";

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
    place: item?.place.trim() || (item ? `${TYPE_LABEL[item.itemType] ?? "장소"} (이름 미입력)` : `일정 #${id}`),
    context: item ? `${item.day}일차 · ${item.seq}번째 일정` : "현재 항목 확인 불가",
  };
}
function current(item: ScheduleItem | undefined): string {
  return item ? when(item.day, item.start, item.end) : "현재 일정 확인 불가";
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
        note: target ? undefined : "대상 일정을 확인한 뒤 미리보기에서 변경 내용을 확인해 주세요.",
      };
    case "REORDER": {
      const other = items.find(it => it.itemId === p.swapWithItemId);
      return {
        action: "두 장소의 방문 순서·시간 교환",
        changes: [
          { ...base, before: current(target), after: other ? when(target?.day, other.start, other.end) : "상대 일정 확인 불가" },
          { ...identity(other, p.swapWithItemId ?? patch.targetItemId), before: current(other), after: target ? when(other?.day, target.start, target.end) : "상대 일정 확인 불가" },
        ],
      };
    }
    case "REPLACE_CONTENT":
      return {
        action: "방문 장소 교체",
        changes: [{ ...base, before: base.place, after: patch.placeName ?? "대체 장소 이름 확인 불가" }],
        note: `${p.distanceMeters !== undefined ? `대체 장소까지 약 ${Math.round(p.distanceMeters / 100) / 10}km · ` : ""}방문 일차·시간은 유지됩니다.`,
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

export function PatchDescription({ patch, product }: { patch: Patch; product: Pick<ProductDetail, "days"> | null }) {
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
  </span>;
}
