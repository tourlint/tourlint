// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductTable } from "./product-workspace";
import type { WorkspaceProduct } from "../lib/workspace";

// 좁은 폭의 상품 표 — 가로 스크롤을 강제하지 않는다 (UI-CM-005 · 006 · #839)
const product: WorkspaceProduct = {
  productId: 69, name: "[임시] 강릉 1박 2일", startDate: "2026-11-17", nights: 1, plannedAt: "2026-09-26",
  region: { regnName: "강원특별자치도", signguName: "강릉시" },
  latestAudit: {
    auditRunId: 205, executedAt: "2026-09-26T00:37:00+09:00", readinessScore: 51, isPartial: false, releasable: false,
    counts: { blocker: 1, error: 2, warning: 1, unverified: 0 },
  },
} as WorkspaceProduct;

const table = () => new DOMParser().parseFromString(renderToStaticMarkup(<ProductTable products={[product]} onDelete={() => undefined} />), "text/html");

describe("상품 표 — 좁은 폭 (#839)", () => {
  it("🔴 휴대폰 폭에서 세로로 쌓을 때 칸마다 이름이 붙는다 — 머리글과 같은 이름", () => {
    const doc = table();
    const heads = [...doc.querySelectorAll("thead th")].map((th) => th.textContent?.trim());
    const labels = [...doc.querySelectorAll("tbody td")].map((td) => td.getAttribute("data-label"));
    // 첫 칸(상품 이름 · 지역 · 버튼)은 이름 없이 맨 위에 선다
    expect(labels[0]).toBeNull();
    expect(labels.slice(1)).toEqual(heads.slice(1));
  });

  it("🔴 태블릿 폭에서 숨길 「최근 검수」 열은 머리글과 칸이 같이 표시된다", () => {
    const doc = table();
    expect([...doc.querySelectorAll(".col-recent")].map((el) => el.tagName)).toEqual(["TH", "TD"]);
  });

  it("🔴 좁은 폭 규칙이 스타일에 있다 — 태블릿은 열 숨김, 휴대폰은 세로 쌓기", () => {
    const css = readFileSync(join(__dirname, "../workspace.css"), "utf8").replace(/\s+/g, " ");
    expect(css).toMatch(/@media \(max-width: 1199px\) \{ \.product-table \.col-recent \{ display: none; \}/);
    expect(css).toMatch(/@media \(max-width: 767px\) \{ \.product-table thead \{ display: none; \}/);
    expect(css).toMatch(/\.product-table td\[data-label\]::before \{ content: attr\(data-label\);/);
  });
});
