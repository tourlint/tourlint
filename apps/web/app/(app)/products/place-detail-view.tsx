"use client";

// 장소 담기 카드 「자세히」 (FR-PL-012 · UI-S2-040). 펼칠 때 detailIntro2 를 실호출해 이용시간 ·
// 쉬는 날 · 요금 · 주차 · 행사 기간 · 문의를 채운다. 캐시가 없어 펼칠 때마다 부른다. 목록에서
// 무장애 · 반려동물로 표시된 곳은 그 축의 상세를 함께 불러 조건을 적는다 (#850) — 목록은 해당
// 여부만 알려 준다. 원문은 응답으로만 흐르고 저장하지 않는다 (DB 명세서 6-4). 등록 화면과
// 기획 화면 카드가 함께 쓴다.

import { useEffect, useState } from "react";
import { ACCESSIBLE_FIELD_LABEL, PET_FIELD_LABEL, conditionRows } from "@tourlint/shared";
import { isApiError, planApi, type PlanPlace, type PlanPlaceDetail } from "../../lib/api";

export function PlaceDetailView({ place: p }: { place: PlanPlace }) {
  const [detail, setDetail] = useState<PlanPlaceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      setErr(null);
      try {
        const d = await planApi.placeDetail(p.contentId, p.contentTypeId, { accessible: p.wheelchair === true, pet: p.pet === true });
        if (alive) setDetail(d);
      } catch (e) {
        if (alive) setErr(isApiError(e) ? e.message : "정보를 불러오지 못했어요.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [p.contentId, p.contentTypeId, p.wheelchair, p.pet]);

  const rows: [string, string | null][] = [
    ["이용시간", detail?.hours ?? null],
    ["쉬는 날", detail?.restDays ?? null],
    ["요금", detail?.fee ?? null],
    ["주차", detail?.parking ?? null],
    ["행사 기간", detail?.eventPeriod ?? null],
    ["문의", detail?.contact ?? null],
  ];
  const accessible = conditionRows(detail?.accessible, ACCESSIBLE_FIELD_LABEL);
  const pet = conditionRows(detail?.pet, PET_FIELD_LABEL);
  const shown = rows.filter(([, v]) => v !== null && v.trim() !== "");

  return (
    <dl className="mt-2 space-y-0.5 border-t border-slate-100 pt-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
      {p.addr1 !== null && <div>{p.addr1}</div>}
      {loading ? (
        <div className="text-slate-400">불러오는 중…</div>
      ) : err !== null ? (
        <div className="text-slate-400">{err}</div>
      ) : (
        <>
          {shown.map(([label, value]) => (
            <div key={label}>
              <span className="text-slate-400">{label}</span> <span className="whitespace-pre-line">{value}</span>
            </div>
          ))}
          {shown.length === 0 && <div className="text-slate-400">관광정보에 올라 있는 이용 정보가 없어요.</div>}
        </>
      )}
      {/* 상세를 못 받았거나 적힌 항목이 없으면 목록이 알려 준 한 줄만 둔다 (EX-PL-004) */}
      {p.wheelchair === true && (
        <Conditions title="무장애 편의" rows={loading ? [] : accessible} fallback="무장애 편의 있음" />
      )}
      {p.pet === true && (
        <Conditions title="반려동물 동반" rows={loading ? [] : pet} fallback="반려동물 동반 가능" />
      )}
    </dl>
  );
}

function Conditions({ title, rows, fallback }: { title: string; rows: { label: string; value: string }[]; fallback: string }) {
  if (rows.length === 0) return <div>{fallback}</div>;
  return (
    <div className="pt-1" data-conditions={title}>
      <div className="font-medium text-slate-600 dark:text-slate-300">{title}</div>
      {rows.map((r) => (
        <div key={r.label}>
          <span className="text-slate-400">{r.label}</span> <span className="whitespace-pre-line">{r.value}</span>
        </div>
      ))}
    </div>
  );
}
