"use client";

// 장소 담기 카드 「자세히」 (FR-PL-012 · UI-S2-040). 펼칠 때 detailIntro2 를 실호출해 이용시간 ·
// 쉬는 날 · 요금 · 주차 · 행사 기간을 채운다. 캐시가 없어 펼칠 때마다 부른다. 목록에 이미 온
// 주소 · 무장애 · 반려동물은 조회 없이 바로 보인다. 원문은 응답으로만 흐르고 저장하지 않는다
// (DB 명세서 6-4). 등록 화면과 기획 화면 카드가 함께 쓴다.

import { useEffect, useState } from "react";
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
        const d = await planApi.placeDetail(p.contentId, p.contentTypeId);
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
  }, [p.contentId, p.contentTypeId]);

  const rows: [string, string | null][] = [
    ["이용시간", detail?.hours ?? null],
    ["쉬는 날", detail?.restDays ?? null],
    ["요금", detail?.fee ?? null],
    ["주차", detail?.parking ?? null],
    ["행사 기간", detail?.eventPeriod ?? null],
  ];
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
      {p.wheelchair === true && <div>무장애 편의 있음</div>}
      {p.pet === true && <div>반려동물 동반 가능</div>}
    </dl>
  );
}
