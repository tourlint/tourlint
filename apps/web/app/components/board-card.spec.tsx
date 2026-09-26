import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductCard, ProductTable } from "./product-workspace";
import type { LatestAudit, WorkspaceProduct } from "../lib/workspace";

const noop = () => undefined;
const audit = (over: Partial<LatestAudit> = {}): LatestAudit => ({
  executedAt: "2026-09-26T05:10:00+09:00", readinessScore: 40, isPartial: false, releasable: false,
  counts: { blocker: 2, error: 1, warning: 0, unverified: 0 }, ...over,
});
const base: WorkspaceProduct = { productId: 7, name: "강릉 감성 2박 3일", startDate: "2099-11-17", nights: 2, plannedAt: "2026-09-26" };

describe("보드 카드의 「출시 불가」 (UI-S1-002)", () => {
  it("🔴 최신 검수가 출시 불가면 보드 카드에도 배지를 붙인다 — 목록 표와 같은 기준", () => {
    const blocked = { ...base, latestAudit: audit() };
    expect(renderToStaticMarkup(<ProductCard product={blocked} onDelete={noop} />)).toContain("출시 불가");
    expect(renderToStaticMarkup(<ProductTable products={[blocked]} onDelete={noop} />)).toContain("출시 불가");
  });

  it("출시할 수 있거나 부분 검수 · 검수 전이면 붙이지 않는다", () => {
    for (const p of [
      { ...base, latestAudit: audit({ releasable: true, counts: { blocker: 0, error: 1, warning: 0, unverified: 0 } }) },
      { ...base, latestAudit: audit({ isPartial: true, readinessScore: null }) },
      { ...base, latestAudit: null },
    ]) {
      expect(renderToStaticMarkup(<ProductCard product={p} onDelete={noop} />)).not.toContain("출시 불가");
    }
  });
});

describe("기획 중 카드 (UI-S1-010)", () => {
  const draft: WorkspaceProduct = { ...base, plannedAt: null, pendingMatches: 2 };

  it("🔴 시작 방식과 고를 장소 수를 붙인다", () => {
    const html = renderToStaticMarkup(<ProductCard product={{ ...draft, startedBy: "MANUAL" }} onDelete={noop} />);
    expect(html).toContain("직접 입력으로 시작 · 아직 고르지 않은 장소 2곳");
    expect(renderToStaticMarkup(<ProductCard product={{ ...draft, startedBy: "TEXT" }} onDelete={noop} />))
      .toContain("메모 붙여넣기로 시작");
  });

  it("기록이 없는 옛 상품은 고를 장소 수만 — 시작 방식을 짓지 않는다", () => {
    const html = renderToStaticMarkup(<ProductCard product={{ ...draft, startedBy: null }} onDelete={noop} />);
    expect(html).toContain("아직 고르지 않은 장소 2곳");
    expect(html).not.toContain("으로 시작");
  });

  it("점수 · 차단은 붙이지 않는다", () => {
    const html = renderToStaticMarkup(<ProductCard product={{ ...draft, startedBy: "UPLOAD", latestAudit: audit() }} onDelete={noop} />);
    expect(html).not.toContain("출시 불가");
    expect(html).not.toContain("차단");
  });
});
