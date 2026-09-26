// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RadarPage from "./page";

// 라우터는 실제처럼 늘 같은 객체다 — 렌더마다 새로 주면 onAuthError 가 바뀌어 효과가 끝없이 다시 돈다
const router = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const kstYesterday = (): string => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

let root: Root; let host: HTMLDivElement;
let summary: () => Promise<Response>;
let today: () => Promise<Response>;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("/api/v1/products")) return json({ content: [], totalPages: 1 });
    if (url.startsWith("/api/v1/notifications")) return json({ content: [], page: 0, size: 20, totalElements: 0, unreadCount: 0 });
    if (url === "/api/v1/settings") return json({ watchKeywords: [], watchRegions: [] });
    if (url === "/api/v1/radar/region-signals") return json([]);
    if (url === "/api/v1/radar/summary") return summary();
    if (url === "/api/v1/radar/today") return today();
    return json({});
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

async function open(): Promise<void> {
  await act(async () => root.render(<RadarPage />));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const WRONG_BEFORE_LOAD = ["아직 확인하기 전이에요", "자동 확인이 꺼져 있어요", "실행 없음", "현재 여행에 확인할 바뀐 정보가 없습니다"];

describe("요약을 읽기 전 · 못 읽었을 때 (UI-S7-010)", () => {
  it("🔴 읽는 동안 「아직 확인하기 전 · 자동 확인이 꺼져 있어요 · 실행 없음」을 띄우지 않는다", async () => {
    summary = () => new Promise(() => undefined);
    await open();
    for (const text of WRONG_BEFORE_LOAD) expect(host.textContent).not.toContain(text);
  });

  it("🔴 못 읽었으면 그 줄들을 비운다 — 목록이 비어도 「없습니다」로 단정하지 않는다", async () => {
    summary = async () => json({ reasonCode: "INTERNAL", message: "레이더를 불러오지 못했습니다." }, 500);
    await open();
    for (const text of WRONG_BEFORE_LOAD) expect(host.textContent).not.toContain(text);
    expect(host.querySelector("[data-empty-meaning]")?.textContent).toBe("지금 보여 드릴 바뀐 정보가 없어요.");
  });
});

describe("바닥 근거 줄 (NF-OB-004 · TM-013)", () => {
  it("🔴 결과를 말로, 조회 건수를 적고 일부만 읽은 날은 0 을 「확인할 것이 없어요」로 적지 않는다", async () => {
    summary = async () => json({
      risk: 0, opportunity: 0, unread: 0, affectedProducts: 0, changedContents: 0,
      lastBatchAt: "2026-09-26T05:00:04+09:00", nextBatchAt: "2026-09-29T05:00:00+09:00",
      lastBatch: { runAt: "2026-09-26T05:00:04+09:00", covered: kstYesterday(), status: "HIDDEN_OVERFLOW", itemCount: 20000 },
    });
    await open();
    const text = host.textContent ?? "";
    expect(text).not.toContain("HIDDEN_OVERFLOW");
    expect(text).toContain("일부만 확인");
    expect(text).toContain("20,000건");
    expect(text).not.toContain("확인할 것이 없어요");
    expect(host.querySelector("[data-empty-meaning]")?.textContent).toContain("일부만 확인했어요");
  });
});

describe("배치가 한 번도 안 돈 DB (batch_state 행은 있고 값은 NULL)", () => {
  it("🔴 근거 줄이 깨지지 않는다 — 조회 건수 · 결과는 「—」, 0 의 뜻은 「아직 확인 전」", async () => {
    summary = async () => json({
      risk: 0, opportunity: 0, unread: 0, affectedProducts: 0, changedContents: 0, lastBatchAt: null, nextBatchAt: null,
      lastBatch: { runAt: null, covered: null, status: null, itemCount: null },
    });
    await open();
    const text = host.textContent ?? "";
    expect(text).toContain("실행 없음");
    expect(text).toContain("조회 건수—");
    expect(text).toContain("결과—");
    expect(text).toContain("아직 확인 전이에요");
    expect(text).not.toContain("null");
  });
});

describe("오늘 할 일 — 요청이 실패하면 (FR-AG-005)", () => {
  it("🔴 「지금은 AI로 정리할 수 없어요」와 까닭을 보인다", async () => {
    summary = async () => json({ risk: 0, opportunity: 0, unread: 0, affectedProducts: 0, changedContents: 0, lastBatchAt: null, nextBatchAt: null, lastBatch: null });
    today = async () => json({ reasonCode: "INTERNAL", message: "요청을 처리할 수 없습니다." }, 500);
    await open();
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "오늘 할 일 보기");
    await act(async () => { button?.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(host.textContent).toContain("지금은 AI로 정리할 수 없어요");
    expect(host.textContent).not.toContain("오늘 챙길 일이 없어요");
  });

  it("앞서 받은 정리가 있어도 실패하면 그 할 일 수를 제목에 남기지 않는다", async () => {
    summary = async () => json({ risk: 0, opportunity: 0, unread: 0, affectedProducts: 0, changedContents: 0, lastBatchAt: null, nextBatchAt: null, lastBatch: null });
    let calls = 0;
    today = async () => (calls++ === 0
      ? json({ basisAt: "2026-09-26T05:00:04+09:00", todos: [{ kind: "CHANGE", productId: 1, region: null, reason: "바뀌었습니다.", action: "REAUDIT" }], quiet: [], incomplete: null })
      : json({ reasonCode: "INTERNAL", message: "요청을 처리할 수 없습니다." }, 500));
    await open();
    const click = async () => {
      const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "오늘 할 일 보기");
      await act(async () => { button?.click(); });
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    };
    await click();
    expect(host.querySelector(".radar-today h2")?.textContent).toMatch(/^오늘 할 일 1 · /);
    await click();
    expect(host.querySelector(".radar-today h2")?.textContent).toBe("오늘 할 일");
    expect(host.textContent).toContain("지금은 AI로 정리할 수 없어요");
  });
});
