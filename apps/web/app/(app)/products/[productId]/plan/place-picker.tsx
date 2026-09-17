"use client";

// 장소 담기 (UI-S2-036~043 · FR-PL-010~016). 시군구 종류 칩을 고르면 그 종류의 장소 목록을
// 보여 주고, [일정에 넣기]로 고른 날에 붙인다. 칩 · 정렬 · 자세히를 눌러도 일정은 바뀌지
// 않는다 — 넣기만 바꾼다. 점수 · 추천 · 인기 같은 말은 쓰지 않는다.
//
// 근처 3km(앵커) · 필터 · 행사 · 걷기 길은 B8-② 에서 더한다.

import { useEffect, useReducer, useState } from "react";
import {
  isApiError,
  itemApi,
  planApi,
  type PlanBriefing,
  type PlanPlace,
  type PlanPlaces,
  type ProductDetail,
} from "../../../../lib/api";
import { initialPickerState, isInserted, pickerReducer } from "./picker-state";

export function PlacePicker({ product, onInserted }: { product: ProductDetail; onInserted: () => Promise<void> }) {
  const [state, dispatch] = useReducer(pickerReducer, initialPickerState);
  const [briefing, setBriefing] = useState<PlanBriefing | null>(null);
  const [places, setPlaces] = useState<PlanPlaces | null>(null);
  const [loadingPlaces, setLoadingPlaces] = useState(false);
  const [day, setDay] = useState(1);
  const [err, setErr] = useState<string | null>(null);

  // 첫째 줄 종류 칩. 지역이 바뀔 때만 다시 세지만 여기선 한 번 읽는다
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const b = await planApi.briefing({
          regnCd: product.ldongRegnCd,
          signguCd: product.ldongSignguCd,
          startDate: product.startDate,
          nights: product.nights,
        });
        if (alive) setBriefing(b);
      } catch (e) {
        if (alive) setErr(isApiError(e) ? e.message : "종류를 불러오지 못했어요.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [product.ldongRegnCd, product.ldongSignguCd, product.startDate, product.nights]);

  // 종류 · 정렬이 바뀌면 목록을 다시 읽는다
  useEffect(() => {
    const lcls2 = state.lcls2;
    if (lcls2 === null) return;
    let alive = true;
    void (async () => {
      setLoadingPlaces(true);
      setErr(null);
      try {
        const res = await planApi.places({ regnCd: product.ldongRegnCd, signguCd: product.ldongSignguCd, lcls2, sort: state.sort });
        if (alive) setPlaces(res);
      } catch (e) {
        if (alive) setErr(isApiError(e) ? e.message : "장소를 불러오지 못했어요.");
      } finally {
        if (alive) setLoadingPlaces(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [state.lcls2, state.sort, product.ldongRegnCd, product.ldongSignguCd]);

  async function insert(p: PlanPlace) {
    setErr(null);
    try {
      await itemApi.addPicked(product.productId, {
        dayNo: day,
        itemType: "SIGHT",
        content: { contentId: p.contentId, contentTypeId: p.contentTypeId, lcls1: p.lcls1, lcls2: p.lcls2, mapx: p.mapx, mapy: p.mapy },
      });
      dispatch({ type: "MARK_INSERTED", contentId: p.contentId });
      await onInserted();
    } catch (e) {
      setErr(isApiError(e) ? e.message : "일정에 넣지 못했어요.");
    }
  }

  const lclsChips = (briefing?.types ?? []).filter((t) => t.kind === "LCLS2");

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

      {briefing === null ? (
        <p className="mt-3 text-sm text-slate-400">불러오는 중…</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {lclsChips.map((t) => (
            <button
              key={t.lcls2}
              type="button"
              onClick={() => t.lcls2 !== null && dispatch({ type: "SELECT_TYPE", lcls2: t.lcls2 })}
              aria-pressed={state.lcls2 === t.lcls2}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
                state.lcls2 === t.lcls2
                  ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300"
                  : "border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              }`}
            >
              {t.name}
              {t.count !== null && <span className="ml-1 tabular-nums text-slate-400">{t.count}</span>}
            </button>
          ))}
        </div>
      )}

      {state.lcls2 !== null && (
        <div className="mt-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-400">{places?.scope.label ?? ""} {places !== null && `${places.totalCount}곳`}</p>
            <div className="flex gap-1 text-xs">
              {(["near", "together"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => dispatch({ type: "SET_SORT", sort: s })}
                  aria-pressed={state.sort === s}
                  className={`rounded px-2 py-0.5 ${state.sort === s ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"}`}
                >
                  {s === "near" ? "가까운 순" : "함께 많이 가는 순"}
                </button>
              ))}
            </div>
          </div>

          {err && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{err}</p>}

          {loadingPlaces ? (
            <p className="mt-3 text-sm text-slate-400">불러오는 중…</p>
          ) : places === null || places.items.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">이 종류의 장소가 없어요.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {places.items.map((p) => (
                <PlaceCard
                  key={p.contentId}
                  place={p}
                  expanded={state.expandedId === p.contentId}
                  inserted={isInserted(state, p.contentId)}
                  onToggle={() => dispatch({ type: "TOGGLE_EXPAND", contentId: p.contentId })}
                  onInsert={() => void insert(p)}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="mt-4 text-xs text-slate-400">출처: ⓒ한국관광공사 · 사진 변경금지</p>
    </section>
  );
}

function PlaceCard({
  place: p,
  expanded,
  inserted,
  onToggle,
  onInsert,
}: {
  place: PlanPlace;
  expanded: boolean;
  inserted: boolean;
  onToggle: () => void;
  onInsert: () => void;
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
          {inserted ? (
            <span className="rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">일정에 있음</span>
          ) : (
            <button type="button" onClick={onInsert} className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-indigo-500">
              일정에 넣기
            </button>
          )}
          <button type="button" onClick={onToggle} className="text-xs text-slate-400 hover:text-slate-600">
            {expanded ? "접기" : "자세히"}
          </button>
        </div>
      </div>
      {expanded && (
        <dl className="mt-2 space-y-0.5 border-t border-slate-100 pt-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          {p.addr1 !== null && <div>{p.addr1}</div>}
          {p.wheelchair === true && <div>무장애 편의 있음</div>}
          {p.pet === true && <div>반려동물 동반 가능</div>}
        </dl>
      )}
    </li>
  );
}
