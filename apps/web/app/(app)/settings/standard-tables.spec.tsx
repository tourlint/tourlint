// @vitest-environment jsdom
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { TARGET_PROFILE_SEED } from "@tourlint/shared";
import { PlaceKindTable, filterPlaceKinds, placeKindRows } from "./tables";
import { ProfileGrid } from "./profiles";

describe("중분류 기준표 (UI-S8-008)", () => {
  it("🔴 체류시간 · 실내 · 야외를 한 표 두 열로, 이름으로 찾는다", () => {
    const rows = placeKindRows();
    expect(rows.length).toBe(59);
    const cafe = filterPlaceKinds(rows, "카페");
    expect(cafe.map((r) => r.name)).toEqual(["카페/ 찻집"]);
    // 공백을 빼고 친 이름으로도 찾는다
    expect(filterPlaceKinds(rows, "카페/찻집").map((r) => r.name)).toEqual(["카페/ 찻집"]);
    expect(cafe[0]?.dwellMinutes).toBe(60);
    expect(cafe[0]?.space).not.toBeNull();
    expect(filterPlaceKinds(rows, "   ")).toHaveLength(59);
  });

  it("🔴 중분류 코드를 화면에 적지 않는다", () => {
    const html = renderToStaticMarkup(<PlaceKindTable />);
    for (const code of ["VE07", "FD05", "EX02", "AC01"]) expect(html).not.toContain(code);
    expect(html).toContain("장소 종류 찾기");
  });
});

describe("타깃 · 콘셉트별 기대 구성 7 × 9 (UI-S8-008)", () => {
  it("🔴 63칸이고 달 표시는 저녁 일정을 기대하는 조합이다", () => {
    const html = renderToStaticMarkup(<ProfileGrid />);
    expect(html.match(/data-profile-cell/g)).toHaveLength(63);
    const nights = TARGET_PROFILE_SEED.filter((p) => p.expectsNight).length;
    // 설명 줄의 표시 하나를 뺀 수가 칸의 달 표시 수다
    expect((html.match(/aria-label="저녁 일정 기대"/g) ?? []).length - 1).toBe(nights);
  });

  it("🔴 칸을 누르면 그 조합의 정의가 보인다", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(host);
    await act(async () => root.render(<ProfileGrid />));
    const cell = host.querySelector<HTMLButtonElement>('button[aria-label="20대 · 감성"]');
    await act(async () => { cell?.click(); });
    expect(host.querySelector("[data-profile-definition]")?.textContent).toBe("20대 · 감성— 자주 넣는 종류: 공예체험 · 카페/ 찻집 · 랜드마크관광 · 19:00 이후 일정");
    await act(async () => root.unmount());
    host.remove();
  });
});
