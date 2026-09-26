import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TodayBriefResult, TodoRow } from "./page";
import { todayFailure, todayTitle } from "../../lib/today-brief";
import type { TodayBrief, TodayItem } from "../../lib/api";

const names = { regns: new Map<string, string>(), signgus: new Map<string, string>() };
const products = new Map([[48, "경주 신라 역사기행 1박 2일"]]);
const change: TodayItem = { kind: "CHANGE", productId: 48, region: null, reason: "담은 곳 1곳의 관광정보가 바뀌었습니다.", action: "REAUDIT" };
const news: TodayItem = { kind: "NEWS", productId: null, region: { regnCd: "51", signguCd: null, month: "2026-11" }, reason: "새로 등록된 곳이 2곳 있습니다.", action: "NEW_PLAN" };
const brief = (over: Partial<TodayBrief> = {}): TodayBrief => ({
  basisAt: "2026-09-26T05:00:04+09:00", todos: [change, news], quiet: [], incomplete: null, ...over,
});
const render = (b: TodayBrief) => renderToStaticMarkup(<TodayBriefResult brief={b} productNames={products} regionNames={names} />);

describe("오늘 할 일 결과 제목 (UI-S7-018)", () => {
  it("🔴 「오늘 할 일 N · 오늘 오전 5시 확인 기준」", () => {
    expect(todayTitle(brief(), "2026-09-26")).toBe("오늘 할 일 2 · 오늘 오전 5시 확인 기준");
    expect(todayTitle(null, "2026-09-26")).toBe("오늘 할 일");
  });

  it("끝까지 정리하지 못했으면 N 을 적지 않는다", () => {
    const partial = brief({ todos: [change], incomplete: { reasonCode: "LLM_UNAVAILABLE", itemIds: [] } });
    expect(todayTitle(partial, "2026-09-26")).toBe("오늘 할 일 · 오늘 오전 5시 확인 기준");
  });
});

describe("줄마다 종류 배지 (UI-S7-018)", () => {
  it("🔴 바뀐 정보 · 새 소식을 알림 카드와 같은 배지로 적는다", () => {
    expect(renderToStaticMarkup(<TodoRow item={change} subject="경주" />)).toContain("바뀐 정보");
    const html = renderToStaticMarkup(<TodoRow item={news} subject="강원 · 11월" />);
    expect(html).toContain("새 소식");
    expect(html).toContain("이 지역으로 새 상품 기획");
  });
});

describe("AI 가 끝까지 못 했을 때 (FR-AG-005 · EX-AG-001 · EX-AG-002)", () => {
  it("🔴 할 일을 하나도 못 정리했으면 「지금은 AI로 정리할 수 없어요」 — 「챙길 일이 없어요」가 아니다", () => {
    const html = render(brief({ todos: [], incomplete: { reasonCode: "LLM_UNAVAILABLE", itemIds: [] } }));
    expect(html).toContain("지금은 AI로 정리할 수 없어요");
    expect(html).toContain("AI가 지금 응답하지 않아요");
    expect(html).not.toContain("오늘 챙길 일이 없어요");
  });

  it("🔴 일부만 정리했으면 정리한 것만 보이고 그 사실을 적는다", () => {
    const html = render(brief({ todos: [change], incomplete: { reasonCode: "BUDGET_EXHAUSTED", itemIds: [] } }));
    expect(html).toContain("경주 신라 역사기행 1박 2일");
    expect(html).toContain("정리한 것만 보여 드려요");
    expect(html).toContain("오늘 쓸 수 있는 관광정보 조회를 모두 썼어요");
  });

  it("끝까지 정리했고 할 일이 없으면 「오늘 챙길 일이 없어요」", () => {
    const html = render(brief({ todos: [] }));
    expect(html).toContain("오늘 챙길 일이 없어요");
    expect(html).not.toContain("지금은 AI로 정리할 수 없어요");
  });

  it("연타 · 동시 실행 제한은 AI 실패가 아니다 — 서버 문장을 쓴다", () => {
    expect(todayFailure({ status: 429, reasonCode: "RATE_LIMIT_EXCEEDED", message: "이미 정리하고 있어요. 끝나면 다시 눌러 주세요." }))
      .toEqual({ unavailable: false, message: "이미 정리하고 있어요. 끝나면 다시 눌러 주세요." });
    expect(todayFailure({ status: 429, reasonCode: "BUDGET_EXHAUSTED", message: "" })).toMatchObject({ unavailable: true });
    expect(todayFailure(new Error("network"))).toMatchObject({ unavailable: true });
  });
});
