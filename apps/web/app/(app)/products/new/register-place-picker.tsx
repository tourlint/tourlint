"use client";

// 등록 폼 옆 장소 담기 (개편안 4-3 · UI-S2-036~043). 저장 전이라 상품이 없다 — 지역만으로
// 브리핑 · 장소를 부르고, [일정에 넣기]는 폼 일정에 곧바로 끼운다(서버 호출 없음).
// 지역이 비어 있으면 기본 템플릿만 보이고, 지역을 넣으면 그 지역 장소로 채운다.
// 점수 · 추천 · 인기 표현은 쓰지 않는다. 근처 3km 는 왼쪽에서 체크한 "고른 줄" 좌표를 기준으로 한다.
// 칸은 접을 수 있고 처음에는 펼쳐 둔다 (UI-S2-036).

import { useEffect, useMemo, useState } from "react";
import { isApiError, planApi, type PlanBriefing, type PlanPlace } from "../../../lib/api";
import { BriefingStatus } from "../briefing-status";
import { PlaceResults } from "../place-results";
import { PlaceDetailView } from "../place-detail-view";
import { NearGuide, PlaceFilters, appliedFilters, hasFilter, unavailableFilters } from "../place-filters";
import { dayCount, type Nights, type Schedule, type ScheduleItem } from "./types";

type NearKind = "MEAL" | "CAFE" | "STAY";
const NEAR_KINDS: { kind: NearKind; label: string; itemType: ScheduleItem["itemType"] }[] = [
  { kind: "MEAL", label: "식당", itemType: "MEAL" },
  { kind: "CAFE", label: "카페", itemType: "REST" },
  { kind: "STAY", label: "숙소", itemType: "LODGING" },
];

interface Filters {
  wheelchair: boolean;
  pet: boolean;
  indoor: boolean;
}

export interface RegisterAnchor {
  contentId: string;
  mapx: number;
  mapy: number;
  label: string;
}

export function RegisterPlacePicker({
  regnCd,
  signguCd,
  startDate,
  nights,
  regionLabel,
  openType = null,
  anchor,
  schedule,
  onInsert,
}: {
  regnCd: string;
  signguCd: string | null;
  startDate: string;
  nights: Nights;
  regionLabel: string;
  openType?: string | null;
  anchor: RegisterAnchor | null;
  schedule: Schedule;
  onInsert: (place: PlanPlace, dayIdx: number, insertAt: number, itemType: ScheduleItem["itemType"]) => void;
}) {
  const [lcls2, setLcls2] = useState<string | null>(openType);
  const [nearKind, setNearKind] = useState<NearKind | null>(null);
  const [sort, setSort] = useState<"near" | "together">("near");
  const [filters, setFilters] = useState<Filters>({ wheelchair: false, pet: false, indoor: false });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [insertingId, setInsertingId] = useState<string | null>(null);
  // 처음에는 펼쳐 둔다 (UI-S2-036)
  const [open, setOpen] = useState(true);
  // 누른 근처 칩의 개수 — 그 조건으로 받은 목록의 전체 수다 (UI-S2-037)
  const [nearTotal, setNearTotal] = useState<{ key: string; total: number } | null>(null);

  const [briefing, setBriefing] = useState<PlanBriefing | null>(null);
  // 종류 목록을 못 받은 이유. 다시 받으면 지운다 — 남겨 두면 성공한 뒤에도 목록 위에 뜬다 (#822)
  const [briefingErr, setBriefingErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  // 지역과 출발일이 모두 있어야 장소를 부른다 (브리핑이 출발일 · 박수로 행사 창을 잡는다)
  const ready = regnCd !== "" && startDate !== "";
  // 앵커(고른 줄)가 없으면 근처 3km 선택은 없는 것으로 친다. 별도 state 동기화 대신 파생한다.
  const activeNear = anchor === null ? null : nearKind;

  // 종류 칩 · 행사 · 걷기 요약 (지역 · 출발일 · 박수가 바뀔 때만). !ready 면 부르지 않는다 —
  // 지난 지역의 briefing 이 남아도 렌더가 ready 로 가려 준다.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void (async () => {
      try {
        const b = await planApi.briefing({ regnCd, signguCd, startDate, nights });
        if (alive) { setBriefing(b); setBriefingErr(null); }
      } catch (e) {
        if (!alive) return;
        // 지난 지역의 종류를 그대로 두지 않는다
        setBriefing(null);
        setBriefingErr(isApiError(e) ? e.message : "종류를 불러오지 못했어요.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [ready, regnCd, signguCd, startDate, nights, reload]);

  // 무장애 · 반려동물 목록을 못 받았으면 그 필터는 쓸 수 없다 — 걸지 않는다 (UI-S2-043 · EX-PL-004)
  const filterOff = unavailableFilters(ready ? briefing : null);
  const applied = appliedFilters(filters, filterOff);
  const placeQuery = !ready || (lcls2 === null && activeNear === null) ? null : {
    regnCd, signguCd,
    ...(activeNear !== null && anchor !== null
      ? { scope: "NEAR3KM" as const, nearKind: activeNear }
      : { lcls2: lcls2 as string, sort }),
    ...(anchor ? { anchor: { mapx: anchor.mapx, mapy: anchor.mapy }, anchorContentId: anchor.contentId } : {}),
    ...applied,
  };
  const queryKey = placeQuery === null ? "" : JSON.stringify(placeQuery);
  const nearCount = activeNear !== null && nearTotal?.key === queryKey ? nearTotal.total : null;
  const clearFilters = () => setFilters({ wheelchair: false, pet: false, indoor: false });

  const lclsChips = (briefing?.types ?? []).filter((t) => t.kind === "LCLS2");
  const nearItemType = activeNear !== null ? (NEAR_KINDS.find((n) => n.kind === activeNear)?.itemType ?? "SIGHT") : "SIGHT";
  const paused = briefing?.budget === "PAUSED";

  const header = (
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">장소 담기</h2>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
        {open ? "접기" : "펼치기"}
      </button>
    </div>
  );
  if (!open) return <section className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">{header}</section>;

  // ── 지역이 없을 때: 기본 템플릿 (개편안 4-3 의 뼈대만) ──────────────────────
  if (regnCd === "") {
    return (
      <section className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
        {header}
        <p className="mt-1 text-xs text-slate-400">여행 지역과 출발일을 넣으면 그 지역의 장소를 여기서 보여드려요.</p>
        {/* 종류 칩 자리 (뼈대) */}
        <div className="mt-4 flex flex-wrap gap-1.5" aria-hidden>
          {["관광지", "문화시설", "음식", "쇼핑", "레포츠"].map((t) => (
            <span key={t} className="rounded-md border border-dashed border-slate-300 px-2.5 py-1 text-xs text-slate-300 dark:border-slate-700 dark:text-slate-600">
              {t}
            </span>
          ))}
        </div>
        {/* 카드 자리 (뼈대) */}
        <ul className="mt-3 space-y-2" aria-hidden>
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex gap-3 rounded-xl border border-dashed border-slate-200 p-3 dark:border-slate-800">
              <div className="h-14 w-14 shrink-0 rounded-md bg-slate-100 dark:bg-slate-800" />
              <div className="flex-1 space-y-2 py-1">
                <div className="h-3 w-2/3 rounded bg-slate-100 dark:bg-slate-800" />
                <div className="h-2.5 w-1/3 rounded bg-slate-100 dark:bg-slate-800" />
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-slate-400">출처: ⓒ한국관광공사 · 사진 변경금지</p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
      {header}
      <p className="mt-1 text-xs text-slate-400">{regionLabel}의 장소예요. 넣을 곳을 골라 일정에 담아 보세요.</p>

      {!ready && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          출발일까지 넣으면 이 지역의 장소를 불러와요.
        </p>
      )}

      {paused && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          오늘 쓸 수 있는 관광정보 조회를 다 써서 장소를 새로 불러올 수 없어요. 내일 다시 시도해 주세요.
        </p>
      )}

      {/* 첫째 줄 — 시군구 전체 종류 */}
      {ready && (briefing === null ? (
        <BriefingStatus error={briefingErr} onRetry={() => { setBriefingErr(null); setReload((n) => n + 1); }} />
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {/* 첫째 줄 머리 — 「(시군구) 전체」 (UI-S2-037) */}
          <span className="mr-1 text-xs text-slate-400">{briefing.region.name || regionLabel} 전체</span>
          {lclsChips.map((t) => (
            <Chip key={t.lcls2} active={lcls2 === t.lcls2} onClick={() => { if (t.lcls2 !== null) { setLcls2(t.lcls2); setNearKind(null); } }}>
              {t.name}
              {t.count !== null && <span className="ml-1 tabular-nums text-slate-400">{t.count}</span>}
            </Chip>
          ))}
        </div>
      ))}

      {/* 둘째 줄 — 고른 줄 근처 3km 식당 · 카페 · 숙소. 머리는 「(기준 줄) 근처 3km」, 누른 칩에는 개수 (UI-S2-037) */}
      {ready && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-slate-400">
            {anchor !== null ? `"${anchor.label}" 근처 3km` : "고른 줄 근처 3km"}
          </span>
          {NEAR_KINDS.map((n) => (
            <Chip key={n.kind} active={activeNear === n.kind} disabled={anchor === null} onClick={() => { if (anchor !== null) { setNearKind(n.kind); setLcls2(null); } }}>
              {n.label}
              {activeNear === n.kind && nearCount !== null && <span className="ml-1 tabular-nums text-slate-400">{nearCount}</span>}
            </Chip>
          ))}
          {anchor === null && <span className="text-xs text-slate-400">왼쪽 일정에서 기준 줄을 체크하면 근처를 볼 수 있어요</span>}
        </div>
      )}
      {ready && <NearGuide />}

      {/* 필터 */}
      {ready && (
        <PlaceFilters filters={filters} off={filterOff}
          onToggle={(key) => setFilters((f) => ({ ...f, [key]: !f[key] }))} onClear={clearFilters} />
      )}

      {ready && (lcls2 !== null || activeNear !== null) && (
        <div className="mt-3">
          <div className="flex items-center justify-between">

            {activeNear === null && (
              <div className="flex gap-1 text-xs">
                {(["near", "together"] as const).map((s) => (
                  <button key={s} type="button" onClick={() => setSort(s)} aria-pressed={sort === s}
                    className={`rounded px-2 py-0.5 ${sort === s ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"}`}>
                    {s === "near" ? "가까운 순" : "함께 많이 가는 순"}
                  </button>
                ))}
              </div>
            )}
          </div>
          <PlaceResults query={placeQuery}
            onClearFilters={hasFilter(applied) ? clearFilters : undefined}
            onLoaded={(d) => setNearTotal({ key: queryKey, total: d.totalCount })}>
            {(p) => (
                <PlaceCard
                  key={p.contentId}
                  place={p}
                  nights={nights}
                  schedule={schedule}
                  expanded={expandedId === p.contentId}
                  inserting={insertingId === p.contentId}
                  onToggle={() => setExpandedId((id) => (id === p.contentId ? null : p.contentId))}
                  onOpenInsert={() => setInsertingId((id) => (id === p.contentId ? null : p.contentId))}
                  onInsert={(dayIdx, insertAt) => {
                    onInsert(p, dayIdx, insertAt, nearItemType);
                    setInsertingId(null);
                  }}
                />
            )}
          </PlaceResults>
        </div>
      )}

      <p className="mt-4 text-xs text-slate-400">출처: ⓒ한국관광공사 · 사진 변경금지</p>
    </section>
  );
}

function Chip({ active, disabled, onClick, children }: { active: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-pressed={active}
      className={`rounded-md border px-2.5 py-1 text-xs font-medium transition disabled:opacity-40 ${
        active ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300"
        : "border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      }`}>
      {children}
    </button>
  );
}

function PlaceCard({
  place: p,
  nights,
  schedule,
  expanded,
  inserting,
  onToggle,
  onOpenInsert,
  onInsert,
}: {
  place: PlanPlace;
  nights: Nights;
  schedule: Schedule;
  expanded: boolean;
  inserting: boolean;
  onToggle: () => void;
  onOpenInsert: () => void;
  onInsert: (dayIdx: number, insertAt: number) => void;
}) {
  return (
    <li className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          {p.firstImage !== null && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.firstImage} alt="" className="h-14 w-14 shrink-0 rounded-md object-cover" />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">{p.title}</p>
            <p className="mt-0.5 text-xs text-slate-400">
              {p.lcls2Name}
              {p.distanceM !== null && ` · ${(p.distanceM / 1000).toFixed(1)}km`}
              {p.togetherRank !== null && ` · 함께 많이 가는 곳 ${p.togetherRank}위`}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <button type="button" onClick={onOpenInsert} aria-expanded={inserting}
            className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-indigo-500">
            {inserting ? "닫기" : "일정에 넣기"}
          </button>
          <button type="button" onClick={onToggle} className="text-xs text-slate-400 hover:text-slate-600">{expanded ? "접기" : "자세히"}</button>
        </div>
      </div>
      {expanded && <PlaceDetailView place={p} />}
      {inserting && <InsertForm nights={nights} schedule={schedule} onConfirm={onInsert} />}
    </li>
  );
}

// 어느 일차 · 어느 자리에 넣을지 고르는 작은 폼 (개편안 4-3 넣을 위치). 맨 앞 · 맨 뒤 포함.
function InsertForm({ nights, schedule, onConfirm }: { nights: Nights; schedule: Schedule; onConfirm: (dayIdx: number, insertAt: number) => void }) {
  const [dayIdx, setDayIdx] = useState(0);
  const [insertAt, setInsertAt] = useState(0);
  const days = dayCount(nights);
  const items = useMemo(() => schedule[dayIdx] ?? [], [schedule, dayIdx]);

  // 위치 옵션: 맨 앞(0) · 각 항목 다음(i+1). 마지막 항목 다음 = 맨 뒤.
  const positions = useMemo(() => {
    const opts: { value: number; label: string }[] = [{ value: 0, label: items.length === 0 ? "맨 앞 (첫 항목)" : "맨 앞" }];
    items.forEach((it, i) => {
      const name = it.place.trim() !== "" ? it.place : `${i + 1}번째 항목`;
      opts.push({ value: i + 1, label: i === items.length - 1 ? `${name} 다음 (맨 뒤)` : `${name} 다음` });
    });
    return opts;
  }, [items]);

  // 일차를 바꾸면 위치가 범위를 벗어날 수 있어 맨 앞으로 되돌린다
  const safeInsertAt = Math.min(insertAt, items.length);

  return (
    <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-2 dark:border-slate-800">
      <label className="flex flex-col gap-1 text-[11px] text-slate-500 dark:text-slate-400">
        일차
        <select
          value={dayIdx}
          onChange={(e) => { setDayIdx(Number(e.target.value)); setInsertAt(0); }}
          className="rounded-md border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
        >
          {Array.from({ length: days }, (_, d) => (
            <option key={d} value={d}>{d + 1}일차</option>
          ))}
        </select>
      </label>
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] text-slate-500 dark:text-slate-400">
        넣을 위치
        <select
          value={safeInsertAt}
          onChange={(e) => setInsertAt(Number(e.target.value))}
          className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
        >
          {positions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={() => onConfirm(dayIdx, safeInsertAt)}
        className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500"
      >
        여기에 넣기
      </button>
    </div>
  );
}
