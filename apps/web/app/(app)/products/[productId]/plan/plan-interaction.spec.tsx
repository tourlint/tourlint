import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlaceAutocomplete } from "./place-autocomplete";
import { PlaceSuggestionCard } from "./place-suggestion-card";
import type { PlaceSuggestions, ProductItem } from "../../../../lib/api";

const noop = async (): Promise<void> => undefined;

const nameless: ProductItem = {
  itemId: 5, seq: 1, start: "18:00", end: null, place: "", itemType: "LODGING",
  ktoContentId: null, matchStatus: "PENDING", mapx: null, mapy: null,
};

describe("이름 없는 줄 — 검색 대신 안내 문구 (#490 · UI-S2-021)", () => {
  it("🔴 이름이 비면 '숙소·식당 이름을 적어 보세요…' 를 보인다", () => {
    const html = renderToStaticMarkup(
      <PlaceAutocomplete item={nameless} regnCd="51" signguCd="150" regionLabel="강릉시" onResolved={noop} />,
    );
    expect(html).toContain("숙소·식당 이름을 적어 보세요…");
  });
});

const suggestions: PlaceSuggestions = {
  items: [{ itemId: 5, kind: "NOT_FOUND", place: null, alternatives: [], reason: "" }],
  summary: { found: 0, notFound: 1, noName: 0 },
  incomplete: null,
};

describe("에이전트 카드 — 못 찾은 줄에 [장소 찾기] (#490 · UI-S2-044)", () => {
  it("🔴 그 줄의 항목이 있으면 [장소 찾기] 버튼을 보인다", () => {
    const html = renderToStaticMarkup(
      <PlaceSuggestionCard suggestions={suggestions} items={[nameless]} regnCd="51" signguCd="150" regionLabel="강릉시" onResolved={noop} />,
    );
    expect(html).toContain("장소 찾기");
  });

  it("항목을 못 찾으면(목록 밖) [장소 찾기]를 숨긴다 — 열 줄이 없다", () => {
    const html = renderToStaticMarkup(
      <PlaceSuggestionCard suggestions={suggestions} onResolved={noop} />,
    );
    expect(html).not.toContain("장소 찾기");
  });
});

// 고른 줄은 카드에서 빠진다 (#763). 위 안내는 상품을 다시 읽어 「1곳」 이 되는데 카드가 응답 시점의
// 「2곳은 못 찾았어요」 를 그대로 두면 서로 어긋난다.
const twoNotFound: PlaceSuggestions = {
  items: [
    { itemId: 5, kind: "NOT_FOUND", place: null, alternatives: [], reason: "경포해변 명칭으로 검색되는 장소가 없음" },
    { itemId: 6, kind: "NOT_FOUND", place: null, alternatives: [], reason: "강릉역 자체 장소가 검색되지 않음" },
  ],
  summary: { found: 0, notFound: 2, noName: 0 },
  incomplete: null,
};
const picked: ProductItem = { ...nameless, itemId: 5, place: "경포해수욕장", ktoContentId: "128758", matchStatus: "CONFIRMED" };
const stillPending: ProductItem = { ...nameless, itemId: 6, place: "강릉역" };

describe("에이전트 카드 — 고른 줄은 카드에서 빠진다 (#763)", () => {
  it("🔴 고른 곳이 된 줄과 그 건수는 보이지 않는다", () => {
    const html = renderToStaticMarkup(
      <PlaceSuggestionCard suggestions={twoNotFound} items={[picked, stillPending]} regnCd="51" signguCd="150" regionLabel="강릉시" onResolved={noop} />,
    );
    expect(html).toContain("1곳은 못 찾았어요");
    expect(html).not.toContain("2곳은 못 찾았어요");
    expect(html).not.toContain("경포해변 명칭으로");
    expect(html).toContain("강릉역 자체 장소가");
  });

  it("🔴 다 골랐으면 카드를 그리지 않는다", () => {
    const excluded: ProductItem = { ...stillPending, matchStatus: "EXCLUDED" };
    const html = renderToStaticMarkup(
      <PlaceSuggestionCard suggestions={twoNotFound} items={[picked, excluded]} regnCd="51" signguCd="150" regionLabel="강릉시" onResolved={noop} />,
    );
    expect(html).toBe("");
  });
});
