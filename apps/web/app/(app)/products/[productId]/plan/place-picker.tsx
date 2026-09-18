"use client";

// 장소 담기 (UI-S2-036~043 · FR-PL-010~018). 시군구 종류 칩(첫째 줄)과 근처 3km 식당 · 카페 ·
// 숙소(둘째 줄, 넣을 위치 앵커 기준), 필터, 행사, 걷기 길을 한 자리에서 담는다. 칩 · 정렬 ·
// 필터 · 넣을 위치를 눌러도 일정은 안 바뀐다 — [일정에 넣기]로만 바뀐다. 점수 · 추천 · 인기
// 표현은 쓰지 않는다.

import { useEffect, useReducer, useState } from "react";
import {
  isApiError,
  itemApi,
  planApi,
  productApi,
  type PlanBriefing,
  type PlanEvent,
  type PlanPlace,
  type PlanWalk,
  type ProductDetail,
} from "../../../../lib/api";
import { isInserted, pickerReducer, pickerStateWith, type NearKind } from "./picker-state";
import { PlaceResults } from "../../place-results";
import { PlaceDetailView } from "../../place-detail-view";

const NEAR_KINDS: { kind: NearKind; label: string; itemType: string }[] = [
  { kind: "MEAL", label: "식당", itemType: "MEAL" },
  { kind: "CAFE", label: "카페", itemType: "REST" },
  { kind: "STAY", label: "숙소", itemType: "LODGING" },
];

const RELATION_LABEL: Record<PlanEvent["relation"], string> = {
  IN: "여행 날짜와 겹쳐요",
  BEFORE: "여행 전에 끝나요",
  AFTER: "여행 뒤에 열려요",
};

export function PlacePicker({ product, onInserted, openType = null }: { product: ProductDetail; onInserted: () => Promise<void>; openType?: string | null }) {
  // "자주 넣는 곳" 칩에서 넘어오면 그 종류를 골라 둔 채로 연다 (UI-S2-030)
  const [state, dispatch] = useReducer(pickerReducer, openType, pickerStateWith);
  const [briefing, setBriefing] = useState<PlanBriefing | null>(null);
  const [day, setDay] = useState(1);
  const [err, setErr] = useState<string | null>(null);

  const confirmedItems = product.days.flatMap((d) => d.items).filter((it) => it.matchStatus === "CONFIRMED" && it.mapx !== null && it.mapy !== null);
  const anchor = confirmedItems.find((it) => it.itemId === state.anchorItemId) ?? null;

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const b = await planApi.briefing({ regnCd: product.ldongRegnCd, signguCd: product.ldongSignguCd, startDate: product.startDate, nights: product.nights });
        if (alive) setBriefing(b);
      } catch (e) {
        if (alive) setErr(isApiError(e) ? e.message : "종류를 불러오지 못했어요.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [product.ldongRegnCd, product.ldongSignguCd, product.startDate, product.nights]);

  const placeQuery = (state.lcls2 === null && state.nearKind === null) || (state.nearKind !== null && anchor === null) ? null : {
    regnCd: product.ldongRegnCd, signguCd: product.ldongSignguCd,
    ...(state.nearKind !== null
      ? { scope: "NEAR3KM" as const, nearKind: state.nearKind }
      : { lcls2: state.lcls2 as string, sort: state.sort }),
    ...(anchor && anchor.mapx !== null && anchor.mapy !== null ? { anchor: { mapx: anchor.mapx, mapy: anchor.mapy }, anchorContentId: anchor.ktoContentId ?? undefined } : {}),
    wheelchair: state.filters.wheelchair, pet: state.filters.pet, indoor: state.filters.indoor,
  };

  async function insert(p: PlanPlace, itemType: string) {
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
    }
  }

  const lclsChips = (briefing?.types ?? []).filter((t) => t.kind === "LCLS2");
  const nearItemType = state.nearKind !== null ? (NEAR_KINDS.find((n) => n.kind === state.nearKind)?.itemType ?? "SIGHT") : "SIGHT";
  const paused = briefing?.budget === "PAUSED";

  return (
    <section className="mt-8 rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">장소 담기</h2>
        <label className="text-xs text-slate-500 dark:text-slate-400">
          넣을 일차{" "}
          <select value={day} onChange={(e) => setDay(Number(e.target.value))} className="rounded-md border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900">
            {Array.from({ length: product.dayCount }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>{d}일차</option>
            ))}
          </select>
        </label>
      </div>

      {paused && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          오늘 공사 데이터 조회량을 다 써서 장소를 새로 불러올 수 없어요. 내일 다시 시도해 주세요.
        </p>
      )}

      {/* 첫째 줄 — 시군구 전체 종류 */}
      {briefing === null ? (
        <p className="mt-3 text-sm text-slate-400">불러오는 중…</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-1.5">
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
            <option value="">고른 장소 다음</option>
            {confirmedItems.map((it) => (
              <option key={it.itemId} value={it.itemId}>{it.place} 다음</option>
            ))}
          </select>
        </label>
        {NEAR_KINDS.map((n) => (
          <Chip
            key={n.kind}
            active={state.nearKind === n.kind}
            disabled={anchor === null}
            onClick={() => anchor !== null && dispatch({ type: "SELECT_NEAR", nearKind: n.kind })}
          >
            {n.label}
          </Chip>
        ))}
        {anchor === null && <span className="text-xs text-slate-400">장소를 고른 뒤 근처를 볼 수 있어요</span>}
      </div>

      {/* 필터 */}
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500 dark:text-slate-400">
        {([["wheelchair", "휠체어 가능"], ["pet", "반려동물 동반"], ["indoor", "실내만"]] as const).map(([key, label]) => (
          <label key={key} className="flex cursor-pointer items-center gap-1">
            <input type="checkbox" checked={state.filters[key]} onChange={() => dispatch({ type: "TOGGLE_FILTER", key })} />
            {label}
          </label>
        ))}
      </div>

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
          <PlaceResults query={placeQuery}>
            {(p) => (
                <PlaceCard key={p.contentId} place={p} expanded={state.expandedId === p.contentId} inserted={isInserted(state, p.contentId)}
                  onToggle={() => dispatch({ type: "TOGGLE_EXPAND", contentId: p.contentId })} onInsert={() => void insert(p, nearItemType)} />
            )}
          </PlaceResults>
        </div>
      )}

      <EventsSection product={product} onChanged={onInserted} />
      <WalksSection product={product} day={day} onInserted={onInserted} />

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

function PlaceCard({ place: p, expanded, inserted, onToggle, onInsert }: { place: PlanPlace; expanded: boolean; inserted: boolean; onToggle: () => void; onInsert: () => void }) {
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
      {expanded && <PlaceDetailView place={p} />}
    </li>
  );
}

// 행사 · 공연 (FR-PL-014). 겹침은 참고 표시일 뿐 판정은 검수의 몫이다. 출발일 옮기기 제안만 준다.
function EventsSection({ product, onChanged }: { product: ProductDetail; onChanged: () => Promise<void> }) {
  const [events, setEvents] = useState<PlanEvent[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await planApi.events({ regnCd: product.ldongRegnCd, signguCd: product.ldongSignguCd, startDate: product.startDate, nights: product.nights });
        if (alive) setEvents(res.items);
      } catch {
        if (alive) setEvents([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [product.ldongRegnCd, product.ldongSignguCd, product.startDate, product.nights]);

  async function moveStart(date: string) {
    setBusy(true);
    try {
      await productApi.update(product.productId, { startDate: date });
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  if (events === null || events.length === 0) return null;
  return (
    <div className="mt-6 border-t border-slate-200 pt-4 dark:border-slate-800">
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">행사 · 공연</h3>
      <ul className="mt-2 space-y-2">
        {events.map((e) => (
          <li key={e.contentId} className="rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-800">
            <p className="font-medium text-slate-800 dark:text-slate-100">{e.title}</p>
            <p className="mt-0.5 text-xs text-slate-400">{e.eventStart} ~ {e.eventEnd} · {RELATION_LABEL[e.relation]}</p>
            {e.suggestedStartDate !== null && (
              <button type="button" onClick={() => void moveStart(e.suggestedStartDate as string)} disabled={busy}
                className="mt-2 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
                출발일을 {Number(e.suggestedStartDate.slice(5, 7))}월 {Number(e.suggestedStartDate.slice(8, 10))}일로
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// 걷기 길 (D9 · FR-PL-015). 넣으면 직접 정한 곳으로 들어간다. 좌표 · 사진이 없어 카드에는
// 이름 · 길이 · 걸리는 시간 · 난이도만 있다.
function WalksSection({ product, day, onInserted }: { product: ProductDetail; day: number; onInserted: () => Promise<void> }) {
  const [walks, setWalks] = useState<PlanWalk[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await planApi.walks({ regnCd: product.ldongRegnCd, signguCd: product.ldongSignguCd });
        if (alive) setWalks(res.items);
      } catch {
        if (alive) setWalks([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [product.ldongRegnCd, product.ldongSignguCd]);

  async function add(walkId: string) {
    setBusyId(walkId);
    try {
      await itemApi.addWalk(product.productId, { dayNo: day, walkId });
      await onInserted();
    } finally {
      setBusyId(null);
    }
  }

  if (walks === null || walks.length === 0) return null;
  return (
    <div className="mt-6 border-t border-slate-200 pt-4 dark:border-slate-800">
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">걷기 길</h3>
      <p className="mt-0.5 text-xs text-slate-400">넣으면 직접 정한 곳으로 들어가요.</p>
      <ul className="mt-2 space-y-2">
        {walks.map((w) => (
          <li key={w.walkId} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-800">
            <div className="min-w-0">
              <p className="truncate font-medium text-slate-800 dark:text-slate-100">{w.name}</p>
              <p className="mt-0.5 text-xs text-slate-400">
                {[w.lengthKm !== null ? `${w.lengthKm}km` : null, w.minutes !== null ? `약 ${w.minutes}분` : null, w.level !== null ? `난이도 ${w.level}` : null].filter(Boolean).join(" · ")}
              </p>
            </div>
            <button type="button" onClick={() => void add(w.walkId)} disabled={busyId === w.walkId}
              className="shrink-0 rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-60">
              일정에 넣기
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
