import { useEffect, useRef } from "react";
import type { Finding, Patch, ProductDetail } from "../../../lib/api";
import { ruleName } from "../../../lib/rule-names";
import { StatusBadge } from "../../../components/badges";
import { dwellDefaultOf } from "../../../lib/dwell-preview";

const TYPES: Record<string, string> = { SIGHT: "관광", MEAL: "식사", REST: "휴식", LODGING: "숙박", MOVE: "이동", FREE: "자유" };

export function relatedItemIds(finding: Finding | null, patch?: Patch): number[] {
  return [...new Set([finding?.target.itemId, finding?.targetSecondary?.itemId, patch?.targetItemId,
    patch?.type === "REORDER" ? patch.payload.swapWithItemId : undefined,
  ].filter((id): id is number => id != null))];
}

/**
 * 표출이 중단된 곳을 가리키는 줄 (FR-RU-066 · UI-S3-025 · #810). 지금 실행의 R06 표출 중단 판정이 짚은 줄이다.
 * 줄은 지우지 않고 흐리게 한 뒤 「표출 중단」 배지를 붙인다.
 */
export function hiddenItemIdsOf(findings: readonly Finding[]): ReadonlySet<number> {
  return new Set(findings
    .filter((f) => f.reasonCode === "CONTENT_HIDDEN" || (f.hiddenContent ?? null) !== null)
    .map((f) => f.target.itemId)
    .filter((id): id is number => id !== null));
}

export function CurrentSchedule({ product, finding, patch, expanded, onToggle, hiddenItemIds = new Set() }: {
  product: Pick<ProductDetail, "days"> | null;
  finding: Finding | null;
  patch?: Patch;
  expanded: boolean;
  onToggle: () => void;
  hiddenItemIds?: ReadonlySet<number>;
}) {
  const scrollArea = useRef<HTMLDivElement>(null);
  const ids = relatedItemIds(finding, patch);
  const highlightKey = ids.join(",");
  useEffect(() => {
    const area = scrollArea.current;
    const target = area?.querySelector<HTMLElement>('[data-related="true"]');
    // 일정표 내부만 이동한다. 문제를 읽던 본문 위치와 키보드 포커스는 유지한다.
    if (expanded && area && target) area.scrollTop += target.getBoundingClientRect().top - area.getBoundingClientRect().top - 12;
  }, [highlightKey, expanded]);
  const days = [...(product?.days ?? [])].sort((a, b) => a.day - b.day);
  const count = days.reduce((n, day) => n + day.items.length, 0);
  const matched = days.flatMap(d => d.items).filter(it => ids.includes(it.itemId)).length;
  return <aside className="current-schedule" aria-label="현재 일정표">
    <div className="current-schedule-heading">
      <div><h3>현재 일정표 <span>{count}개 일정</span></h3><p>저장된 일정 · 수정안 확정 전</p></div>
      <button type="button" aria-expanded={expanded} aria-controls="current-schedule-content" onClick={onToggle}>{expanded ? "접기" : "펼치기"}</button>
    </div>
    {expanded && <div id="current-schedule-content">
      <p className="current-schedule-hint" role="status">{finding
        ? `${ruleName(finding.ruleCode)} · ${ids.length === 0 ? "상품 전체를 함께 살펴보세요." : matched === 0 ? "현재 일정에서 대상 항목을 찾을 수 없어요." : `관련 일정 ${matched}곳 강조`}`
        : "문제 카드의 버튼이나 수정안을 선택하면 관련 장소를 강조해 드려요."}</p>
      <div ref={scrollArea} className="current-schedule-scroll" tabIndex={0} role="region" aria-label="일차별 현재 일정">
        {!product ? <p className="p-4 text-sm">현재 일정을 불러오지 못했어요.</p> : count === 0 ? <p className="p-4 text-sm">저장된 일정이 없어요.</p> : days.map(day => <section key={day.day} aria-label={`${day.day}일차`} className="current-schedule-day">
          <h4>{day.day}일차 <span>{day.items.length}개 일정</span></h4>
          <ol>{[...day.items].sort((a, b) => a.seq - b.seq).map(it => { const dwell = dwellDefaultOf(it); return <li key={it.itemId} data-related={ids.includes(it.itemId)} data-hidden={hiddenItemIds.has(it.itemId)}>
            {/* 끝 시간을 비운 줄은 검수가 채운 시각(회색)과 「기본값 적용 · N분」 (FR-IN-011 · EX-IN-009) */}
            <div className="current-schedule-time">{it.start || "시작 미입력"} – {it.end || (dwell?.preview ? <span className="text-slate-400">{dwell.end}</span> : "종료 미입력")}
              {dwell !== null && <StatusBadge status="DEFAULT_APPLIED" detail={`${dwell.minutes}분`} className="ml-1.5 align-middle" />}</div>
            <strong>{it.place.trim() || `${TYPES[it.itemType] ?? "장소"} (이름 미입력)`}</strong>
            {/* 표출이 중단된 곳 — 지우지 않고 흐리게 둔다 (FR-RU-066) */}
            {hiddenItemIds.has(it.itemId) && <StatusBadge status="DISPLAY_STOPPED" className="current-schedule-hidden-badge" />}
            <div className="current-schedule-meta"><span>{it.seq}번째 · {TYPES[it.itemType] ?? it.itemType}</span>{ids.includes(it.itemId) && <b>관련 일정</b>}</div>
          </li>; })}</ol>
        </section>)}
      </div>
      <p className="current-schedule-footnote">수정안을 선택해도 이 일정은 바뀌지 않아요. 변경 예정 내용은 미리보기에서 비교하세요.</p>
    </div>}
  </aside>;
}
