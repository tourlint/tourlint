// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planApi, type PlanPlace, type PlanPlaces } from "../../lib/api";
import { PlaceResults } from "./place-results";

let host: HTMLDivElement;
let root: Root;
const query = { regnCd: "51", signguCd: "150", lcls2: "NA02" };
const card = (p: PlanPlace) => <li key={p.contentId}>{p.title}</li>;
function response(page = 1, total = 34, prefix = "장소"): PlanPlaces {
  return { scope: { kind: "SIGNGU", label: "강릉시 전체" }, totalCount: total, notice: null,
    items: Array.from({ length: Math.min(20, Math.max(0, total - (page - 1) * 20)) }, (_, i) => ({
      contentId: `${prefix}${(page - 1) * 20 + i + 1}`, title: `${prefix}${(page - 1) * 20 + i + 1}`,
    } as PlanPlace)),
  };
}
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find(b => b.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function render(q = query) {
  await act(async () => root.render(<PlaceResults query={q}>{card}</PlaceResults>));
}
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe("장소 목록 탐색 (#564)", () => {
  it("34곳의 마지막 14곳까지 이동하고 이전으로 돌아온다", async () => {
    const api = vi.spyOn(planApi, "places").mockImplementation(async q => response(q.page));
    await render();
    expect(host.textContent).toContain("전체 34곳 중 1–20곳");
    expect(host.querySelectorAll("li")).toHaveLength(20);
    await click("다음 →");
    expect(api).toHaveBeenLastCalledWith({ ...query, page: 2 });
    expect(host.textContent).toContain("전체 34곳 중 21–34곳");
    expect(host.querySelectorAll("li")).toHaveLength(14);
    expect([...host.querySelectorAll("button")].filter(b => b.textContent === "다음 →").every(b => b.disabled)).toBe(true);
    await click("← 이전");
    expect(host.textContent).toContain("1–20곳");
  });

  it("조건을 바꾸면 1페이지로 돌아가고 이전 조건의 늦은 응답을 무시한다", async () => {
    let finish!: (r: PlanPlaces) => void;
    const api = vi.spyOn(planApi, "places").mockImplementation(async q => {
      if (q.lcls2 === "NA02" && q.page === 2) return new Promise(r => { finish = r; });
      return response(1, q.lcls2 === "VE01" ? 6 : 34, q.lcls2);
    });
    await render(); await click("다음 →");
    expect(host.textContent).toContain("불러오는 중");
    await render({ ...query, lcls2: "VE01" });
    expect(api).toHaveBeenLastCalledWith({ ...query, lcls2: "VE01", page: 1 });
    await act(async () => finish(response(2, 34, "과거")));
    expect(host.textContent).toContain("전체 6곳 중 1–6곳");
    expect(host.textContent).not.toContain("과거");
    expect(host.querySelectorAll("nav")).toHaveLength(0);
  });

  it("다음 페이지 실패 시 재시도는 같은 페이지를 다시 불러온다", async () => {
    const api = vi.spyOn(planApi, "places").mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(response(2));
    await render(); await click("다음 →");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await click("다시 시도");
    expect(api).toHaveBeenLastCalledWith({ ...query, page: 2 });
    expect(host.textContent).toContain("21–34곳");
  });

  it("필터 결과가 0이면 빈 상태만 표시한다", async () => {
    vi.spyOn(planApi, "places").mockResolvedValue(response(1, 0));
    await render();
    expect(host.textContent).toContain("전체 0곳");
    expect(host.textContent).toContain("이 조건에 맞는 장소가 없어요");
    expect(host.querySelectorAll("nav")).toHaveLength(0);
  });

  it("🔴 목록 아래에도 전체 수와 지금 범위를 적는다 (UI-S2-036)", async () => {
    vi.spyOn(planApi, "places").mockImplementation(async q => response(q.page));
    await render();
    expect(host.textContent?.match(/전체 34곳 중 1–20곳/g)).toHaveLength(2);
    const last = [...host.querySelectorAll("p")].at(-1);
    expect(last?.textContent).toBe("전체 34곳 중 1–20곳");
  });

  it("🔴 필터가 켜진 채 0곳이면 빈 상태에 「필터 모두 끄기」 를 둔다 — 저절로 풀지 않는다 (UI-S2-038 · EX-PL-001)", async () => {
    vi.spyOn(planApi, "places").mockResolvedValue(response(1, 0));
    const clear = vi.fn();
    await act(async () => root.render(<PlaceResults query={{ ...query, wheelchair: true }} onClearFilters={clear}>{card}</PlaceResults>));
    await click("필터 모두 끄기");
    expect(clear).toHaveBeenCalledTimes(1);
    await render();
    expect([...host.querySelectorAll("button")].some(b => b.textContent === "필터 모두 끄기")).toBe(false);
  });

  it("받은 목록의 전체 수를 알려 준다 — 누른 근처 칩의 개수 (UI-S2-037)", async () => {
    vi.spyOn(planApi, "places").mockResolvedValue(response(1, 7));
    const loaded = vi.fn();
    await act(async () => root.render(<PlaceResults query={query} onLoaded={loaded}>{card}</PlaceResults>));
    expect(loaded).toHaveBeenCalledWith(expect.objectContaining({ totalCount: 7 }));
  });
});
