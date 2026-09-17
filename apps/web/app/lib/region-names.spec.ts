import { describe, expect, it } from "vitest";
import { EMPTY_REGION_NAMES, regionLabel, type RegionNameMaps } from "./region-names";

const maps: RegionNameMaps = {
  regns: new Map([["51", "강원특별자치도"]]),
  signgus: new Map([["51:150", "강릉시"]]),
};

describe("regionLabel — 지역 코드를 이름으로 (UI-S7-014)", () => {
  it("시도 · 시군구 이름을 찾으면 이름으로 적는다", () => {
    expect(regionLabel(maps, "51", "150")).toBe("강원특별자치도 강릉시");
  });

  it("시군구가 없으면 시도만 적는다", () => {
    expect(regionLabel(maps, "51", null)).toBe("강원특별자치도");
    expect(regionLabel(maps, "51", "")).toBe("강원특별자치도");
  });

  it("🔴 이름을 못 찾은 조각은 코드를 그대로 둔다 — 지어내지 않는다", () => {
    expect(regionLabel(EMPTY_REGION_NAMES, "51", "150")).toBe("51 150");
    // 시도는 알고 시군구만 모르면 시도만 이름으로 바뀐다
    expect(regionLabel(maps, "51", "999")).toBe("강원특별자치도 999");
  });
});
