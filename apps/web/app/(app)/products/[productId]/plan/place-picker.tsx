"use client";

// 장소 담기 (UI-S2-036~043 · FR-PL-010~018). 시군구 종류 칩(첫째 줄)과 근처 3km 식당 · 카페 ·
// 숙소(둘째 줄, 넣을 위치 앵커 기준), 필터, 행사, 걷기 길을 한 자리에서 담는다. 칩 · 정렬 ·
// 필터 · 넣을 위치를 눌러도 일정은 안 바뀐다 — [일정에 넣기]로만 바뀐다. 점수 · 추천 · 인기
// 표현은 쓰지 않는다. 편집기 옆 칸은 접을 수 있고 처음에는 펼쳐 둔다 (UI-S2-036).

import { useEffect, useReducer, useRef, useState } from "react";
import {
  isApiError,
  itemApi,
  planApi,
  productApi,
  type PlanBriefing,
  type PlanPlace,
  type ProductDetail,
} from "../../../../lib/api";
import { isInserted, pickerReducer, pickerStateWith, type NearKind } from "./picker-state";
import { LCLS_SYSTM2 } from "@tourlint/shared";
import { BriefingStatus } from "../../briefing-status";
import { PlaceResults } from "../../place-results";
import { PlaceDetailView } from "../../place-detail-view";
import { NearGuide, PlaceFilters, appliedFilters, hasFilter, unavailableFilters } from "../../place-filters";
import { EventsSection, WalksSection } from "../../plan-extras";

const NEAR_KINDS: { kind: NearKind; label: string; itemType: string }[] = [
  { kind: "MEAL", label: "식당", itemType: "MEAL" },
  { kind: "CAFE", label: "카페", itemType: "REST" },
  { kind: "STAY", label: "숙소", itemType: "LODGING" },
];

export interface PickerContext {
  initialDay?: number;
  initialAnchorId?: number | null;
  initialNearKind?: NearKind | null;
  suggestedTypes?: string[];
  openType?: string | null;
}

export function PlacePicker({ product, onInserted, openType = null, initialDay = 1, initialAnchorId = null, initialNearKind = null, suggestedTypes = [], onBusyChange, showExtras = true, collapsible = showExtras }: { product: ProductDetail; onInserted: () => Promise<void>; onBusyChange?: (busy: boolean) => void; showExtras?: boolean; /** 편집기 옆 칸이면 접을 수 있다. 검수 서랍은 서랍이 닫는다 */ collapsible?: boolean } & PickerContext) {
  const [state, dispatch] = useReducer(pickerReducer, { ...pickerStateWith(openType), anchorItemId: initialAnchorId, nearKind: initialNearKind });
  // 처음에는 펼쳐 둔다 (UI-S2-036)
  const [open, setOpen] = useState(true);
  // 누른 근처 칩의 개수 — 그 조건으로 받은 목록의 전체 수다 (UI-S2-037)
  const [nearTotal, setNearTotal] = useState<{ key: string; total: number } | null>(null);
  const [briefing, setBriefing] = useState<PlanBriefing | null>(null);
  const [day, setDay] = useState(initialDay);
  const [err, setErr] = useState<string | null>(null);
  // 종류 목록 오류는 넣기 오류와 따로 둔다. 다시 받으면 지운다 (#822)
  const [briefingErr, setBriefingErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [inserting, setInserting] = useState(false);
  const insertLock = useRef(false);
  const confirmedItems = product.days.filter(d => d.day === day).flatMap(d => d.items).filter(it => it.matchStatus === "CONFIRMED" && it.mapx !== null && it.mapy !== null);
  const anchor = confirmedItems.find((it) => it.itemId === state.anchorItemId) ?? null;

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const b = await planApi.briefing({ regnCd: product.ldongRegnCd, signguCd: product.ldongSignguCd, startDate: product.startDate, nights: product.nights });
        if (alive) { setBriefing(b); setBriefingErr(null); }
      } catch (e) {
        if (alive) setBriefingErr(isApiError(e) ? e.message : "종류를 불러오지 못했어요.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [product.ldongRegnCd, product.ldongSignguCd, product.startDate, product.nights, reload]);

  // 무장애 · 반려동물 목록을 못 받았으면 그 필터는 쓸 수 없다 — 걸지 않는다 (UI-S2-043 · EX-PL-004)
  const filterOff = unavailableFilters(briefing);
  const applied = appliedFilters(state.filters, filterOff);
  const placeQuery = (state.lcls2 === null && state.nearKind === null) || (state.nearKind !== null && anchor === null) ? null : {
    regnCd: product.ldongRegnCd, signguCd: product.ldongSignguCd,
    ...(state.nearKind !== null
      ? { scope: "NEAR3KM" as const, nearKind: state.nearKind }
      : { lcls2: state.lcls2 as string, sort: state.sort }),
    ...(anchor && anchor.mapx !== null && anchor.mapy !== null ? { anchor: { mapx: anchor.mapx, mapy: anchor.mapy }, anchorContentId: anchor.ktoContentId ?? undefined } : {}),
    ...applied,
  };
  const queryKey = placeQuery === null ? "" : JSON.stringify(placeQuery);
  const nearCount = state.nearKind !== null && nearTotal?.key === queryKey ? nearTotal.total : null;

  async function insert(p: PlanPlace, itemType: string) {
    if (insertLock.current) return;
    insertLock.current = true;
    setInserting(true);
    onBusyChange?.(true);
    setErr(null);
    try {
      await itemApi.addPicked(product.productId, {
        dayNo: day,
        itemType,
        // 넣을 위치를 고르면 그 항목 다음에 끼운다 (4-3). 안 고르면 그 날 끝에 붙는다
        afterItemId: state.anchorItemId,
        content: { contentId: p.contentId, contentTypeId: p.contentTypeId, lcls1: p.lcls1, lcls2: p.lcls2, mapx: p.mapx, mapy: p.mapy },
      });
      dispatch({ type: "MARK_INSERTED", contentId: p.contentId });
      await onInserted();
    } catch (e) {
      setErr(isApiError(e) ? e.message : "일정에 넣지 못했어요.");
    } finally {
      insertLock.current = false;
      setInserting(false);
      onBusyChange?.(false);
    }
  }

  const lclsChips = (briefing?.types ?? []).filter((t) => t.kind === "LCLS2");
  for (const code of suggestedTypes) {
    if (LCLS_SYSTM2[code] && !lclsChips.some(t => t.lcls2 === code)) {
      lclsChips.push({ kind: "LCLS2", lcls2: code, name: LCLS_SYSTM2[code].name, count: null, nearKind: null, disabled: null });
    }
  }
  const nearItemType = state.nearKind !== null ? (NEAR_KINDS.find((n) => n.kind === state.nearKind)?.itemType ?? "SIGHT") : "SIGHT";
  const paused = briefing?.budget === "PAUSED";

  // 첫째 줄 머리 — 「(시군구) 전체」 (UI-S2-037)
  const areaName = briefing?.region.name || product.region?.signguName || product.region?.regnName || "이 지역";

  return (
    <fieldset disabled={inserting} className="mt-8 rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">장소 담기</h2>
        <div className="flex items-center gap-2">
          {open && (
            <label className="text-xs text-slate-500 dark:text-slate-400">
              넣을 일차{" "}
              <select value={day} onChange={(e) => { setDay(Number(e.target.value)); dispatch({ type: "SET_ANCHOR", anchorItemId: null }); }} className="rounded-md border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900">
                {Array.from({ length: product.dayCount }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>{d}일차</option>
                ))}
              </select>
            </label>
          )}
          {collapsible && (
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
              {open ? "접기" : "펼치기"}
            </button>
          )}
        </div>
      </div>

      {open && <>

      {paused && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          오늘 쓸 수 있는 관광정보 조회를 다 써서 장소를 새로 불러올 수 없어요. 내일 다시 시도해 주세요.
        </p>
      )}

      {/* 첫째 줄 — 시군구 전체 종류 */}
      {briefing === null ? (
        <BriefingStatus error={briefingErr} onRetry={() => { setBriefingErr(null); setReload((n) => n + 1); }} />
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-slate-400">{areaName} 전체</span>
          {lclsChips.map((t) => (
            <Chip key={t.lcls2} active={state.lcls2 === t.lcls2} onClick={() => t.lcls2 !== null && dispatch({ type: "SELECT_TYPE", lcls2: t.lcls2 })}>
              {t.name}
              {t.count !== null && <span className="ml-1 tabular-nums text-slate-400">{t.count}</span>}
            </Chip>
          ))}
        </div>
      )}

      {/* 둘째 줄 — 넣을 위치 근처 3km 식당 · 카페 · 숙소 */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <label className="mr-1 text-xs text-slate-400">
          넣을 위치{" "}
          <select
            value={state.anchorItemId ?? ""}
            onChange={(e) => dispatch({ type: "SET_ANCHOR", anchorItemId: e.target.value === "" ? null : Number(e.target.value) })}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
          >
            {/* 비워 두면 그 일차 맨 뒤에 붙는다 — 이름을 동작대로 (UI-S2-039) */}
            <option value="">맨 뒤</option>
            {confirmedItems.map((it) => (
              <option key={it.itemId} value={it.itemId}>{it.place} 다음</option>
            ))}
          </select>
        </label>
      </div>
      {/* 둘째 줄 머리 — 「(앞 장소) 근처 3km」. 누른 칩에는 개수를 적는다 (UI-S2-037) */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-slate-400">{anchor !== null ? `${anchor.place} 근처 3km` : "근처 3km"}</span>
        {NEAR_KINDS.map((n) => (
          <Chip
            key={n.kind}
            active={state.nearKind === n.kind}
            disabled={anchor === null}
            onClick={() => anchor !== null && dispatch({ type: "SELECT_NEAR", nearKind: n.kind })}
          >
            {n.label}
            {state.nearKind === n.kind && nearCount !== null && <span className="ml-1 tabular-nums text-slate-400">{nearCount}</span>}
          </Chip>
        ))}
        {anchor === null && <span className="text-xs text-slate-400">장소를 고른 뒤 근처를 볼 수 있어요</span>}
      </div>
      <NearGuide />

      {/* 필터 */}
      <PlaceFilters filters={state.filters} off={filterOff}
        onToggle={(key) => dispatch({ type: "TOGGLE_FILTER", key })} onClear={() => dispatch({ type: "CLEAR_FILTERS" })} />

      {(state.lcls2 !== null || state.nearKind !== null) && (
        <div className="mt-3">
          <div className="flex items-center justify-between">

            {state.nearKind === null && (
              <div className="flex gap-1 text-xs">
                {(["near", "together"] as const).map((s) => (
                  <button key={s} type="button" onClick={() => dispatch({ type: "SET_SORT", sort: s })} aria-pressed={state.sort === s}
                    className={`rounded px-2 py-0.5 ${state.sort === s ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"}`}>
                    {s === "near" ? "가까운 순" : "함께 많이 가는 순"}
                  </button>
                ))}
              </div>
            )}
          </div>
          {err && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{err}</p>}
          <PlaceResults query={placeQuery}
            onClearFilters={hasFilter(applied) ? () => dispatch({ type: "CLEAR_FILTERS" }) : undefined}
            onLoaded={(d) => setNearTotal({ key: queryKey, total: d.totalCount })}>
            {(p) => (
                <PlaceCard key={p.contentId} place={p} target={product.targetKey} expanded={state.expandedId === p.contentId} inserted={isInserted(state, p.contentId) || product.days.some(d => d.items.some(it => it.ktoContentId === p.contentId))}
                  onToggle={() => dispatch({ type: "TOGGLE_EXPAND", contentId: p.contentId })} onInsert={() => void insert(p, nearItemType)} />
            )}
          </PlaceResults>
        </div>
      )}

      {showExtras && <>
        {/* 출발일 옮기기는 상품을 바로 고친다 — 항목 시각은 그대로다 (FR-PL-014) */}
        <EventsSection regnCd={product.ldongRegnCd} signguCd={product.ldongSignguCd} startDate={product.startDate} nights={product.nights}
          onMoveStart={async (date) => { await productApi.update(product.productId, { startDate: date }); await onInserted(); }} />
        {/* 걷기 길 목록을 못 받았으면 칸을 없애지 않고 「지금은 볼 수 없어요」 (UI-S2-043). 넣으면 넣을 일차 끝에 붙는다 */}
        <WalksSection regnCd={product.ldongRegnCd} signguCd={product.ldongSignguCd} unavailable={briefing !== null && briefing.walks === null}
          onAdd={async (w) => { await itemApi.addWalk(product.productId, { dayNo: day, walkId: w.walkId }); await onInserted(); }} />
      </>}

      <p className="mt-4 text-xs text-slate-400">출처: ⓒ한국관광공사 · 사진 변경금지</p>
      </>}
    </fieldset>
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

function PlaceCard({ place: p, target, expanded, inserted, onToggle, onInsert }: { place: PlanPlace; target: string | null; expanded: boolean; inserted: boolean; onToggle: () => void; onInsert: () => void }) {
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
          {inserted ? (
            <span className="rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">일정에 있음</span>
          ) : (
            <button type="button" onClick={onInsert} className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-indigo-500">일정에 넣기</button>
          )}
          <button type="button" onClick={onToggle} className="text-xs text-slate-400 hover:text-slate-600">{expanded ? "접기" : "자세히"}</button>
        </div>
      </div>
      {/* 상품 타깃에 따라 앞에 오는 정보가 다르다 (UI-S2-040) */}
      {expanded && <PlaceDetailView place={p} target={target} />}
    </li>
  );
}
