// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import RadarPage from "./page";

// 라우터는 실제처럼 늘 같은 객체다 — 렌더마다 새로 주면 onAuthError 가 바뀌어 효과가 끝없이 다시 돈다
const router = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

// 레이더에 보인 알림을 확인 처리한다 (UI-CM-008 · #804)
const card = (id: number, readAt: string | null) => ({
  notificationId: id, kind: "RISK", condition: 2, productId: 1, productName: "강릉 역사 2박 3일", startDate: "2026-09-28",
  ktoContentId: "3021124", placeName: null, schedule: null, changes: [], current: [], modifiedOn: "2026-09-24",
  eventPeriod: null, overlapDays: [], what: "공사에서 이 관광지의 표출이 중단됐습니다.", impact: "", action: "",
  hidden: true, fingerprint: { from: null, to: null }, dismissable: false, readAt, dismissedAt: null,
  createdAt: "2026-09-25T19:54:01+09:00",
});
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
let root: Root; let host: HTMLDivElement; let calls: string[];
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.startsWith("/api/v1/products")) return json({ content: [], totalPages: 1 });
    if (url === "/api/v1/notifications?kind=RISK") {
      return json({ content: [card(4, null), card(5, "2026-09-25T20:00:00+09:00")], page: 0, size: 20, totalElements: 2, unreadCount: 1 });
    }
    if (/^\/api\/v1\/notifications\/\d+\/read$/.test(url)) return json({ id: 4, readAt: "2026-09-25T20:01:00+09:00" });
    if (url === "/api/v1/settings") return json({ watchKeywords: [], watchRegions: [] });
    if (url === "/api/v1/radar/region-signals") return json([]);
    if (url === "/api/v1/radar/summary") {
      return json({ risk: 2, opportunity: 0, unread: 1, affectedProducts: 1, changedContents: 1, lastBatchAt: null, nextBatchAt: null, lastBatch: null });
    }
    return json({});
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("🔴 바뀐 정보 탭에 보인 알림 중 처음 보는 것만 확인 처리하고, 보는 동안 「새로」를 남긴다", async () => {
  await act(async () => root.render(<RadarPage />));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(calls.filter((c) => c.endsWith("/read"))).toEqual(["POST /api/v1/notifications/4/read"]);
  expect(host.querySelectorAll("[data-new]")).toHaveLength(1);
});
