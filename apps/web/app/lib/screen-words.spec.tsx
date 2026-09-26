import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findForbidden, visibleText } from "./screen-words";
import { PlaceFactsLine } from "../(app)/products/[productId]/plan/place-facts-line";
import { DaySummary } from "../(app)/products/[productId]/plan/day-summary";
import { PlaceSuggestionCard } from "../(app)/products/[productId]/plan/place-suggestion-card";
import { CheckQuestionsCard } from "../(app)/products/[productId]/check-questions-card";
import type { PlaceFacts, PlaceSuggestions, ProductItem } from "./api";

const facts: PlaceFacts = {
  itemId: 1, name: "해변 카페", kindName: "카페/찻집", hours: "08:00-20:00", restDays: "매주 화요일",
  fee: null, parking: "가능", eventPeriod: null, travelFromPrevMinutes: 9, matchedBy: "AGENT", origin: "PICKER",
};

const items: ProductItem[] = [
  { itemId: 1, seq: 1, start: "10:00", end: "12:00", place: "경포대", itemType: "SIGHT", ktoContentId: "1", matchStatus: "CONFIRMED", mapx: null, mapy: null },
  { itemId: 2, seq: 2, start: "13:00", end: "18:50", place: "오죽헌", itemType: "SIGHT", ktoContentId: "2", matchStatus: "CONFIRMED", mapx: null, mapy: null },
];

const suggestions: PlaceSuggestions = {
  items: [{ itemId: 1, kind: "FOUND", place: { contentId: "1", contentTypeId: 12, title: "초당순두부", kindName: "음식점", addr: "강릉시 초당동" }, alternatives: [], reason: "앞 일정과 가장 가까운 곳이에요" }],
  summary: { found: 1, notFound: 0, noName: 0 },
  incomplete: null,
};

const noop = async (): Promise<void> => undefined;

describe("화면 말 낱말 검사 — 만드는 쪽 말이 화면에 없다 (UI-CM-040~043)", () => {
  it("기획 화면 컴포넌트에 금지 낱말이 없다 (장소 정보 한 줄 · 일차 요약)", () => {
    const html = renderToStaticMarkup(<PlaceFactsLine facts={facts} />) + renderToStaticMarkup(<DaySummary day={1} items={items} />);
    expect(findForbidden(html, true)).toEqual([]);
  });

  it("기획 에이전트 카드에 금지 낱말이 없다", () => {
    const html = renderToStaticMarkup(<PlaceSuggestionCard suggestions={suggestions} onResolved={noop} />);
    expect(findForbidden(html, true)).toEqual([]);
  });

  it("검수 에이전트 카드에 금지 낱말이 없다", () => {
    const html = renderToStaticMarkup(<CheckQuestionsCard runId={1} itemLabel={() => "경포대"} />);
    expect(findForbidden(html, false)).toEqual([]);
  });
});

describe("findForbidden — 화면별 규칙과 근거 칸 제외", () => {
  it("공통 금지 낱말은 어느 화면에서든 잡는다", () => {
    expect(findForbidden("<p>지문 abc</p>", false)).toContain("지문");
    expect(findForbidden("<p>지문 abc</p>", true)).toContain("지문");
  });

  it("판정 말(R01 · 차단)은 기획 화면에서만 막고 검수 결과에서는 허용한다", () => {
    expect(findForbidden("<p>R01 차단</p>", true)).toEqual(expect.arrayContaining(["R01", "차단"]));
    expect(findForbidden("<p>R01 차단</p>", false)).toEqual([]);
  });

  it("🔴 근거 칸 안에 같은 태그가 또 있어도 칸 끝까지 뺀다 — 첫 닫는 태그에서 끊지 않는다", () => {
    const html = "<div data-evidence><div>조회 시각</div><div>데이터 지문 abc</div><p>규칙셋 1.2.9</p></div><p>화면 글자</p>";
    expect(visibleText(html)).toBe("<p>화면 글자</p>");
    expect(findForbidden(html, false)).toEqual([]);
    // 칸 밖의 같은 낱말은 잡는다
    expect(findForbidden(`${html}<div>지문</div>`, false)).toEqual(["지문"]);
  });

  it("🔴 접힌 근거 칸(data-evidence) 안의 말은 검사에서 뺀다", () => {
    // 가드: 기획 화면에 R01 이 그냥 있으면 빨강
    expect(findForbidden("<p>R01</p>", true)).toContain("R01");
    // 같은 R01 을 근거 칸에 넣으면 초록
    expect(findForbidden("<div data-evidence><p>R01</p></div>", true)).toEqual([]);
    expect(visibleText("<div data-evidence>규칙셋 1.2.3</div>")).not.toContain("규칙셋");
  });
});
