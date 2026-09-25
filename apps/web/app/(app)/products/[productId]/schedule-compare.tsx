// 반영 전후 일정표 (수정안 미리보기 · 전후 비교 화면 UI-S5-003 · FR-PA-042 · #806).
// 같은 줄(id)끼리 견줘 추가 · 제거 · 변경을 색과 글자로 가른다. 두 화면이 같은 기준을 쓴다.

import type { PatchItem } from "../../../lib/api";

export type ChangeStatus = "same" | "changed" | "added" | "removed";

const ITEM_TYPE_LABEL: Record<string, string> = {
  SIGHT: "관광",
  MEAL: "식사",
  LODGING: "숙박",
  REST: "휴식",
  MOVE: "이동",
  FREE: "자유",
};

interface DayGroup {
  day: number;
  items: PatchItem[];
}

/**
 * 항목의 상태를 정하는 지문 — 하나라도 다르면 '변경'으로 본다.
 *
 * 순번(seq)은 넣지 않는다. 앞에 한 줄이 들어가거나 빠지면 뒤 줄의 순번이 모두 밀려서, 시각도
 * 장소도 그대로인 줄이 전부 「변경」으로 칠해졌다(#806). 일차를 옮기거나 순서를 바꾸는 수정안은
 * 일차나 시각이 함께 바뀐다.
 */
function signature(it: PatchItem): string {
  return `${it.dayNo}|${it.startTime}|${it.endTime ?? ""}|${it.itemType}|${it.placeLabel}`;
}

/** 좌(전)·우(후) 각 항목의 상태를 id 기준으로 계산한다 */
export function compareSchedules(
  before: readonly PatchItem[],
  after: readonly PatchItem[],
): { beforeStatus: Map<number, ChangeStatus>; afterStatus: Map<number, ChangeStatus>; anyChange: boolean } {
  const beforeById = new Map(before.map((it) => [it.id, it]));
  const afterById = new Map(after.map((it) => [it.id, it]));
  const beforeStatus = new Map<number, ChangeStatus>();
  const afterStatus = new Map<number, ChangeStatus>();
  let anyChange = false;

  for (const it of before) {
    const a = afterById.get(it.id);
    if (a === undefined) {
      beforeStatus.set(it.id, "removed");
      anyChange = true;
    } else if (signature(it) !== signature(a)) {
      beforeStatus.set(it.id, "changed");
      anyChange = true;
    } else {
      beforeStatus.set(it.id, "same");
    }
  }
  for (const it of after) {
    const b = beforeById.get(it.id);
    if (b === undefined) {
      afterStatus.set(it.id, "added");
      anyChange = true;
    } else if (signature(it) !== signature(b)) {
      afterStatus.set(it.id, "changed");
    } else {
      afterStatus.set(it.id, "same");
    }
  }
  return { beforeStatus, afterStatus, anyChange };
}

/** 항목을 일차별로 묶고 seq 로 정렬한다 */
function groupByDay(items: readonly PatchItem[]): DayGroup[] {
  const byDay = new Map<number, PatchItem[]>();
  for (const it of items) {
    const list = byDay.get(it.dayNo) ?? [];
    list.push(it);
    byDay.set(it.dayNo, list);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, list]) => ({ day, items: [...list].sort((a, b) => a.seq - b.seq) }));
}

const STATUS_ROW: Record<ChangeStatus, string> = {
  same: "border-slate-200 dark:border-slate-800",
  changed: "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30",
  added: "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30",
  removed: "border-rose-300 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/30",
};

// 색만으로 가르지 않는다 — 줄에 글자로도 적는다
const STATUS_TEXT: Record<Exclude<ChangeStatus, "same">, string> = {
  changed: "변경",
  added: "추가",
  removed: "제거",
};

/** 한쪽 일정 전체를 일차별로 그린다. 변경/추가/제거 항목은 색과 글자로 강조한다 */
function ScheduleColumn({
  title,
  days,
  statusOf,
}: {
  title: string;
  days: DayGroup[];
  statusOf: (itemId: number) => ChangeStatus;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</h3>
      <div className="mt-3 space-y-4">
        {days.map((d) => (
          <div key={d.day}>
            <p className="text-xs font-medium text-slate-400">{d.day}일차</p>
            <ul className="mt-1.5 space-y-1.5">
              {d.items.map((it) => {
                const status = statusOf(it.id);
                return (
                  <li
                    key={it.id}
                    data-status={status}
                    className={`rounded-lg border px-3 py-2 text-sm ${STATUS_ROW[status]} ${
                      status === "removed" ? "opacity-70" : ""
                    }`}
                  >
                    {/* 제거한 줄은 줄을 긋되, 뒤의 「제거」 글자까지 긋지 않는다 */}
                    <span className={status === "removed" ? "line-through" : ""}>
                      <span className="tabular-nums text-slate-500 dark:text-slate-400">
                        {it.startTime}
                        {it.endTime ? `~${it.endTime}` : ""}
                      </span>
                      <span className="ml-2 text-slate-800 dark:text-slate-100">{it.placeLabel}</span>
                      <span className="ml-2 text-xs text-slate-400">{ITEM_TYPE_LABEL[it.itemType] ?? it.itemType}</span>
                    </span>
                    {status !== "same" && (
                      <span className="ml-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                        {STATUS_TEXT[status]}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 전후 두 칸과 범례. 바뀐 것이 없으면 그렇게 적는다 */
export function ScheduleComparison({
  before,
  after,
  beforeTitle,
  afterTitle,
  emptyText,
}: {
  before: readonly PatchItem[];
  after: readonly PatchItem[];
  beforeTitle: string;
  afterTitle: string;
  emptyText: string;
}) {
  const cmp = compareSchedules(before, after);
  return (
    <>
      {!cmp.anyChange && <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">{emptyText}</p>}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <ScheduleColumn title={beforeTitle} days={groupByDay(before)} statusOf={(id) => cmp.beforeStatus.get(id) ?? "same"} />
        <ScheduleColumn title={afterTitle} days={groupByDay(after)} statusOf={(id) => cmp.afterStatus.get(id) ?? "same"} />
      </div>

      <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-amber-300" />변경</span>
        <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-emerald-300" />추가</span>
        <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-rose-300" />제거</span>
      </div>
    </>
  );
}
