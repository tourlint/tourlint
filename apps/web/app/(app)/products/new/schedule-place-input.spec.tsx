import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SchedulePlaceInput } from "./schedule-place-input";
import type { MatchedContent } from "./types";

const noop = (): void => undefined;
const content: MatchedContent = {
  contentId: "126508", contentTypeId: 12, mapx: 126.9, mapy: 37.5, lcls1: "VE", lcls2: "VE01", lcls3: null,
};

describe("등록 행 장소 자동완성 (UI-S2-020 · 개편안 4-2 변경 지점 3)", () => {
  it("🔴 아직 안 고른 줄은 입력칸을 보인다", () => {
    const html = renderToStaticMarkup(
      <SchedulePlaceInput value="" content={null} regnCd="11" signguCd={null} regionLabel="서울특별시" onChange={noop} />,
    );
    expect(html).toContain("장소명");
    expect(html).toContain("예: 경복궁"); // placeholder
    expect(html).not.toContain("다시 고르기");
  });

  it("🔴 고른 줄은 ✓ 와 이름·다시 고르기를 보인다 (입력칸 대신)", () => {
    const html = renderToStaticMarkup(
      <SchedulePlaceInput value="경복궁" content={content} regnCd="11" signguCd={null} regionLabel="서울특별시" onChange={noop} />,
    );
    expect(html).toContain("✓");
    expect(html).toContain("경복궁");
    expect(html).toContain("다시 고르기");
  });
});
