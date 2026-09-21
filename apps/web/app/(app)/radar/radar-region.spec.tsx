import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QuietRegionRow, RegionNewsCard, hasRegion, hasRegionNews, quietRegionText, recentDays } from "./page";
import type { RegionSignal } from "../../lib/api";

const window30 = { from: "2026-08-23", to: "2026-09-21" };
const signal = (over: Partial<RegionSignal> = {}): RegionSignal => ({
  region: { regnCd: "12", signguCd: "130" },
  month: "2026-10",
  t1: { count: 2, byType: { "39": 2 }, window: window30, computedAt: "2026-09-21T05:00:00+09:00", keywordHits: [] },
  t2: { count: 3, byType: { "15": 3 }, window: { from: "2026-10-01", to: "2026-10-31" }, computedAt: "2026-09-21T05:00:00+09:00", keywordHits: [] },
  t3: { count: 1_264_094, basisMonth: "2025-10", source: "빅데이터 지역별 방문자수", computedAt: "2026-09-21T05:00:00+09:00" },
  ...over,
} as RegionSignal);

const quiet = signal({
  t1: { count: 0, byType: {}, window: window30, computedAt: "", keywordHits: [] },
  t2: { count: 0, byType: {}, window: { from: "2026-11-01", to: "2026-11-30" }, computedAt: "", keywordHits: [] },
  month: "2026-11",
} as Partial<RegionSignal>);

describe("관심 지역 카드 — 숫자마다 기준 기간을 사용자 말로 (UI-S7-015 · #705)", () => {
  it("🔴 어느 달 행사인지 · 최근 며칠인지를 줄에 적는다", () => {
    const html = renderToStaticMarkup(<RegionNewsCard signal={signal()} regionName="여수시" />);
    expect(html).toContain("10월 행사 3건");
    expect(html).toContain("최근 30일 새로 등록된 곳 2곳");
    expect(html).toContain("지난해 10월 방문자 1,264,094명");
    expect(html).not.toContain("이달 행사");
  });

  it("🔴 만드는 쪽 말이 없다 — 기준 기간 · 새 콘텐츠 · 출처 서비스 이름 · 근거 보기", () => {
    const html = renderToStaticMarkup(<RegionNewsCard signal={signal()} regionName="여수시" />);
    for (const word of ["기준 기간", "새 콘텐츠", "빅데이터", "근거 보기", "방문자 기준"]) expect(html, word).not.toContain(word);
  });

  it("0 인 줄은 적지 않는다", () => {
    const onlyEvents = signal({ t1: { count: 0, byType: {}, window: window30, computedAt: "", keywordHits: [] } } as Partial<RegionSignal>);
    const html = renderToStaticMarkup(<RegionNewsCard signal={onlyEvents} regionName="여수시" />);
    expect(html).toContain("10월 행사 3건");
    expect(html).not.toContain("새로 등록된 곳 0곳");
  });

  it("센 기간은 창에서 읽는다 — 30일로 박지 않는다", () => {
    expect(recentDays(signal())).toBe(30);
    expect(recentDays(signal({ t1: { count: 1, byType: {}, window: { from: "2026-09-08", to: "2026-09-21" }, computedAt: "", keywordHits: [] } } as Partial<RegionSignal>))).toBe(14);
    expect(recentDays(signal({ t1: null }))).toBeNull();
  });
});

describe("소식이 없는 지역 — 0 을 늘어놓지 않고 한 줄로 (#705)", () => {
  it("🔴 행사도 새로 등록된 곳도 없으면 소식 없는 지역이다", () => {
    expect(hasRegionNews(quiet)).toBe(false);
    expect(hasRegionNews(signal())).toBe(true);
  });

  it("키워드와 맞는 곳이 있으면 소식이 있는 것이다", () => {
    const hit = signal({
      t1: { count: 0, byType: {}, window: window30, computedAt: "", keywordHits: [] },
      t2: { count: 0, byType: {}, window: window30, computedAt: "", keywordHits: [{ keyword: "커피", contentIds: ["1"] }] },
    } as Partial<RegionSignal>);
    expect(hasRegionNews(hit)).toBe(true);
  });

  it("🔴 0건 · 0곳 대신 그 뜻을 적는다", () => {
    const html = renderToStaticMarkup(<QuietRegionRow signal={quiet} regionName="속초시" />);
    expect(html).toContain("11월 행사와 최근 30일 새로 등록된 곳은 아직 없어요.");
    expect(html).not.toContain("0건");
    expect(html).not.toContain("0곳");
    // 등록한 지역은 숨기지 않는다 — 이름과 기획 진입점이 그대로 있다
    expect(html).toContain("속초시 · 2026-11");
    expect(html).toContain("이 지역으로 새 상품 기획");
  });

  it("🔴 아직 세어 보지 않은 지역은 「없다」 가 아니라 「아직」 이다", () => {
    const fresh = signal({ t1: null, t2: null, t3: null });
    expect(quietRegionText(fresh)).toBe("방금 추가한 지역이에요. 다음 확인 때 채워져요.");
    expect(renderToStaticMarkup(<QuietRegionRow signal={fresh} regionName="경주시" />)).not.toContain("아직 없어요");
  });
});

describe("관심 지역 중복 (#712)", () => {
  const mine = [{ regnCd: "51", signguCd: "210", month: "2026-11" }, { regnCd: "36110", signguCd: null, month: "2026-11" }];

  it("🔴 같은 시도 · 시군구 · 달이면 이미 있는 것이다", () => {
    expect(hasRegion(mine, "51", "210", "2026-11")).toBe(true);
    expect(hasRegion(mine, "36110", null, "2026-11")).toBe(true);
  });

  it("달이나 시군구가 다르면 다른 지역이다", () => {
    expect(hasRegion(mine, "51", "210", "2026-12")).toBe(false);
    expect(hasRegion(mine, "51", "150", "2026-11")).toBe(false);
    expect(hasRegion(mine, "51", null, "2026-11")).toBe(false);
  });
});
