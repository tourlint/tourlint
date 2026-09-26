// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentApi, matchApi, type ContentDetail, type ContentSearchResult } from "../../../lib/api";
import { SchedulePlaceInput } from "./schedule-place-input";
import { ScheduleEditor } from "./schedule-editor";
import { buildPayload } from "./product-payload";
import type { MatchedContent, Schedule } from "./types";

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

describe("「찾는 곳이 없나요? 직접 정한 곳으로 두기」 (UI-S2-021 · FR-IN-025)", () => {
  const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

  it("🔴 누르면 그 줄을 직접 정한 곳으로 둔다 — 목록만 닫지 않는다", async () => {
    vi.spyOn(matchApi, "search").mockResolvedValue(result([]));
    const change = vi.fn();
    await act(async () => root.render(<SchedulePlaceInput value="강릉역" content={null} regnCd="51" signguCd="150" regionLabel="강릉시" onChange={change} />));
    await act(async () => host.querySelector("input")!.focus());
    await settle();
    await act(async () => button("찾는 곳이 없나요? 직접 정한 곳으로 두기")!.click());
    expect(change).toHaveBeenCalledWith({ excluded: true });
  });

  it("🔴 직접 정한 곳으로 둔 줄은 표시와 [다시 고르기]만 있고 찾지 않는다", async () => {
    const search = vi.spyOn(matchApi, "search").mockResolvedValue(result([]));
    const change = vi.fn();
    await act(async () => root.render(<SchedulePlaceInput value="강릉역" content={null} excluded regnCd="51" signguCd="150" regionLabel="강릉시" onChange={change} />));
    await settle();
    expect(host.textContent).toContain("직접 정한 곳");
    expect(host.textContent).toContain("강릉역");
    expect(host.querySelector("input")).toBeNull();
    expect(search).not.toHaveBeenCalled();
    await act(async () => button("다시 고르기")!.click());
    expect(change).toHaveBeenCalledWith({ excluded: false });
  });

  it("🔴 고른 후보를 확인하는 동안에는 누를 수 없다 — 고른 곳과 직접 정한 곳이 겹치지 않는다", async () => {
    vi.spyOn(matchApi, "search").mockResolvedValue(result(["강릉역"]));
    vi.spyOn(contentApi, "detail").mockReturnValue(new Promise<ContentDetail>(() => {}));
    const change = vi.fn();
    await act(async () => root.render(<SchedulePlaceInput value="강릉역" content={null} regnCd="51" signguCd="150" regionLabel="강릉시" onChange={change} />));
    await act(async () => host.querySelector("input")!.focus());
    await settle();
    await act(async () => host.querySelector<HTMLButtonElement>("li button")!.click());
    const exclude = button("찾는 곳이 없나요? 직접 정한 곳으로 두기")!;
    expect(exclude.disabled).toBe(true);
    await act(async () => exclude.click());
    expect(change).not.toHaveBeenCalled();
  });

  it("줄 수 없는 줄(편집 화면의 저장된 고른 곳)에는 그 선택지를 두지 않는다", async () => {
    vi.spyOn(matchApi, "search").mockResolvedValue(result([]));
    await act(async () => root.render(<SchedulePlaceInput value="오죽헌" content={null} canExclude={false} regnCd="51" signguCd="150" regionLabel="강릉시" onChange={() => {}} />));
    await act(async () => host.querySelector("input")!.focus());
    await settle();
    expect(button("찾는 곳이 없나요? 직접 정한 곳으로 두기")).toBeUndefined();
  });
});

describe("고른 줄 [다시 고르기] · [취소] (UI-S2-025)", () => {
  const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  function Row({ onPatch }: { onPatch: (p: unknown) => void }) {
    const [row, setRow] = useState<{ place: string; content: MatchedContent | null; excluded?: boolean }>({ place: "경포대", content });
    return (
      <SchedulePlaceInput value={row.place} content={row.content} excluded={row.excluded === true} regnCd="51" signguCd="150" regionLabel="강릉시"
        onChange={(p) => { onPatch(p); setRow((r) => ({ ...r, ...p })); }} />
    );
  }
  async function typeSearch(text: string) {
    const input = host.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    await act(async () => input.dispatchEvent(new Event("input", { bubbles: true })));
    await settle();
  }

  it("🔴 다시 고르기를 눌러야 찾고, [취소]로 고른 곳에 돌아간다 — 줄은 한 번도 바뀌지 않는다", async () => {
    const search = vi.spyOn(matchApi, "search").mockResolvedValue(result(["경포대"]));
    const patches: unknown[] = [];
    await act(async () => root.render(<Row onPatch={(p) => patches.push(p)} />));
    await settle();
    expect(search).not.toHaveBeenCalled();
    await act(async () => button("다시 고르기")!.click());
    await settle();
    // 찾는 칸에 초점이 가고 목록이 열린다
    expect(document.activeElement).toBe(host.querySelector("input"));
    expect(search).toHaveBeenCalledWith("경포대", "51", "150");
    expect(host.textContent).toContain("강릉시에서 찾은 곳 1곳");
    expect(host.textContent).toContain("고르지 않으면 지금 고른 곳을 그대로 둬요");
    await act(async () => button("취소")!.click());
    expect(host.textContent).toContain("✓");
    expect(host.querySelector("input")).toBeNull();
    expect(patches).toEqual([]);
  });

  it("🔴 다시 고르는 동안 찾는 칸에 쳐도 줄을 바꾸지 않는다 — 검색어일 뿐이다", async () => {
    const search = vi.spyOn(matchApi, "search").mockResolvedValue(result([]));
    const patches: unknown[] = [];
    await act(async () => root.render(<Row onPatch={(p) => patches.push(p)} />));
    await act(async () => button("다시 고르기")!.click());
    await typeSearch("하이오");
    expect(search).toHaveBeenLastCalledWith("하이오", "51", "150");
    expect(patches).toEqual([]);
  });

  it("🔴 다시 고르다 「직접 정한 곳으로 두기」를 누르면 찾는 칸의 글자로 직접 정한 곳이 된다", async () => {
    vi.spyOn(matchApi, "search").mockResolvedValue(result([]));
    const patches: unknown[] = [];
    await act(async () => root.render(<Row onPatch={(p) => patches.push(p)} />));
    await act(async () => button("다시 고르기")!.click());
    await typeSearch("세인트존스");
    await act(async () => button("찾는 곳이 없나요? 직접 정한 곳으로 두기")!.click());
    expect(patches).toEqual([{ place: "세인트존스", content: null, excluded: true }]);
    expect(host.textContent).toContain("직접 정한 곳");
  });

  it("이름을 불러오지 못한 고른 곳은 빈칸 대신 그렇다고 적는다 — 줄 이름에는 쓰지 않는다", () => {
    const html = renderToStaticMarkup(
      <SchedulePlaceInput value="" content={content} regnCd="51" signguCd="150" regionLabel="강릉시" onChange={noop} />,
    );
    expect(html).toContain("이름을 불러오지 못한 곳");
  });
});

describe("등록 화면 — 고른 줄을 다시 고르다 저장하면 (UI-S2-025 · DR-PR-001)", () => {
  it("🔴 고르지 않고 저장하면 고른 곳 그대로 나간다 — 칸의 글자나 공식 명칭이 고르는 중인 줄 이름으로 나가지 않는다", async () => {
    vi.spyOn(matchApi, "search").mockResolvedValue(result([]));
    const picked = { contentId: "142785", contentTypeId: 32, mapx: 128.9, mapy: 37.8, lcls1: "AC", lcls2: "AC01", lcls3: null };
    let current: Schedule = [];
    function Form() {
      const [schedule, setSchedule] = useState<Schedule>([[
        { id: "it-1", start: "18:00", end: "", place: "세인트존스 호텔", itemType: "LODGING", origin: "MANUAL", content: picked },
      ]]);
      current = schedule;
      return <ScheduleEditor nights={0} schedule={schedule} onChange={setSchedule} regnCd="51" signguCd="150" regionLabel="강릉시" />;
    }
    await act(async () => root.render(<Form />));
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "다시 고르기")!.click());
    const input = [...host.querySelectorAll("input")].find((i) => i.getAttribute("aria-label") === "장소명")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "하이오");
    await act(async () => input.dispatchEvent(new Event("input", { bubbles: true })));
    await settle();
    const row = buildPayload({
      name: "강릉", region: { regnCode: "51", signguCode: "150" }, startDate: "2026-11-17", nights: 0,
      schedule: current, target: "", concept: "", headcount: "", transport: "CAR",
    }).days[0]?.items[0];
    expect(row).toMatchObject({ place: "", content: picked });
    expect(JSON.stringify(row)).not.toContain("하이오");
  });
});
