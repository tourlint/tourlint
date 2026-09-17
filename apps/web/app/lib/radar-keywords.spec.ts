import { describe, expect, it } from "vitest";
import { addKeyword, removeKeyword } from "./radar-keywords";

describe("addKeyword — 관심 키워드 편집 (FR-MO-059)", () => {
  it("공백을 떼고 넣는다", () => {
    expect(addKeyword([], "  온천 ")).toEqual({ list: ["온천"], error: null });
  });

  it("빈 값은 막고 이유를 준다", () => {
    const r = addKeyword(["온천"], "   ");
    expect(r.list).toEqual(["온천"]);
    expect(r.error).not.toBeNull();
  });

  it("중복은 막는다", () => {
    const r = addKeyword(["온천"], "온천");
    expect(r.list).toEqual(["온천"]);
    expect(r.error).not.toBeNull();
  });

  it("삭제는 그 키워드만 뺀다", () => {
    expect(removeKeyword(["온천", "벚꽃"], "온천")).toEqual(["벚꽃"]);
  });
});
