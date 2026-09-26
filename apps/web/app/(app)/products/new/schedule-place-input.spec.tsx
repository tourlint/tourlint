// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchApi, type ContentSearchResult } from "../../../lib/api";
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

const result = (titles: string[]): ContentSearchResult => ({
  regionFilterApplied: true, fetchedAt: "2026-09-26", totalCount: titles.length, source: "",
  candidates: titles.map((title, i) => ({ contentid: String(i + 1), title, addr1: null, contenttypeid: 12, cpyrhtDivCd: null })),
});

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 350)); });
async function typed(value: string) {
  await act(async () => root.render(<SchedulePlaceInput value={value} content={null} regnCd="51" signguCd="150" regionLabel="강릉시" onChange={() => {}} />));
  await act(async () => host.querySelector("input")!.focus());
  await settle();
}

describe("등록 화면 장소 칸 — 검색 실패와 0곳 (EX-MC-004 · EX-PL-010)", () => {
  it("🔴 검색 호출이 실패하면 0곳 문구 대신 실패와 [다시 시도]를 준다", async () => {
    const search = vi.spyOn(matchApi, "search").mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(result(["세인트존스 호텔"]));
    await typed("세인트존스");
    expect(host.textContent).toContain("장소를 검색하지 못했어요.");
    expect(host.textContent).not.toContain("관광정보에 올라 있는 이름으로");
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "다시 시도")!.click());
    await settle();
    expect(search).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("강릉시에서 찾은 곳 1곳");
  });

  it("🔴 0곳이면 관광정보에 올라 있는 이름으로 검색해 보라고 한다", async () => {
    vi.spyOn(matchApi, "search").mockResolvedValue(result([]));
    await typed("없는 가게");
    expect(host.textContent).toContain("관광정보에 올라 있는 이름으로 검색해 보세요");
    expect(host.textContent).not.toContain("검색하지 못했어요");
  });
});
