// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WatchChip } from "./page";

describe("관심 키워드 · 지역 칩 (UI-S7-012 · 014 · #946)", () => {
  it("🔴 지우는 버튼에 무엇을 지우는지 이름이 있다 — 「×」 만으로는 알 수 없다", () => {
    expect(renderToStaticMarkup(<WatchChip label="커피" onRemove={() => {}} />)).toContain('aria-label="커피 삭제"');
    expect(renderToStaticMarkup(<WatchChip label="강원특별자치도 속초시 · 2026-11" onRemove={() => {}} />))
      .toContain('aria-label="강원특별자치도 속초시 · 2026-11 삭제"');
  });

  it("보이는 것은 그대로다 — 이름과 「×」", () => {
    const html = renderToStaticMarkup(<WatchChip label="커피" onRemove={() => {}} />);
    expect(html).toContain(">커피<");
    expect(html).toContain(">×</button>");
  });
});
