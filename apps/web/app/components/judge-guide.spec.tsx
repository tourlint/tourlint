import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JudgeGuide } from "./product-workspace";

/**
 * 가이드는 노션에 있는데 서비스 어디에도 링크가 없었다. 제출 URL 로 들어온 심사위원이
 * 「이걸 어떻게 보나」를 스스로 찾아야 했다 (#609).
 */
describe("심사위원 체험 가이드 진입점 (#609)", () => {
  const html = renderToStaticMarkup(<JudgeGuide />);

  it("🔴 공개 가이드는 새 탭으로 연다", () => {
    expect(html).toContain("app.notion.com");
    const link = html.match(/<a[^>]*app\.notion\.com[^>]*>/)?.[0] ?? "";
    expect(link).toContain('target="_blank"');
    // 새 탭으로 여는 링크에 rel 이 없으면 연 쪽 창을 건드릴 수 있다
    expect(link).toContain('rel="noreferrer"');
  });

  it("🔴 노션을 못 여는 환경을 위해 PDF 도 준다", () => {
    expect(html).toMatch(/<a[^>]*href="\/judge-guide\.pdf"[^>]*download/);
  });

  it("무엇인지 한 줄로 알려 준다 (#653)", () => {
    expect(html).toContain("심사위원이신가요?");
  });

  /**
   * PDF 는 노션에서 내보내 손으로 넣는 파일이다 — 저장소가 만들어 주지 않는다. 링크만 남고
   * 파일이 빠지면 화면에선 멀쩡해 보이고 누른 사람만 404 를 본다 (#653).
   */
  it("🔴 PDF 링크가 가리키는 파일이 실제로 있다", () => {
    const href = html.match(/href="(\/[^"]+\.pdf)"/)?.[1] ?? "";
    expect(href).not.toBe("");
    const pdf = readFileSync(join(__dirname, "../../public", href));
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });
});
