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
