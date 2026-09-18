"use client";

import type { PlaceFacts } from "../../../../lib/api";

/** 표시용 관광정보. 판정은 검수에서 하며 긴 운영정보를 생략하지 않는다. */
export function PlaceFactsLine({ facts }: { facts: PlaceFacts }) {
  return (
    <div className="plan-place-facts">
      <div className="plan-place-meta">
        {facts.kindName && <span>{facts.kindName}</span>}
        {facts.matchedBy === "AGENT" && <span>AI가 찾음</span>}
        {facts.origin === "PICKER" && <span>장소 담기에서 넣음</span>}
      </div>
      <dl className="plan-facts-grid">
        <div><dt>이용 · 영업시간</dt><dd>{facts.hours?.trim() || "제공된 정보가 없어요"}</dd></div>
        <div><dt>쉬는 날</dt><dd>{facts.restDays?.trim() || "제공된 정보가 없어요"}</dd></div>
        {facts.eventPeriod && <div className="plan-facts-wide"><dt>행사 기간</dt><dd>{facts.eventPeriod}</dd></div>}
      </dl>
      {(facts.fee || facts.parking) && (
        <details className="plan-extra-facts">
          <summary>요금 · 주차 정보</summary>
          <dl className="plan-facts-grid">
            {facts.fee && <div><dt>이용 요금</dt><dd>{facts.fee}</dd></div>}
            {facts.parking && <div><dt>주차</dt><dd>{facts.parking}</dd></div>}
          </dl>
        </details>
      )}
    </div>
  );
}
