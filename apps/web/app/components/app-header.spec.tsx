// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authApi, radarApi, type AccountView, type RadarSummary } from "../lib/api";
import { announceNotificationsChanged } from "../lib/notification-badge";
import { AppHeader } from "./app-header";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/" }));

// 헤더 알림 건수 (UI-CM-008 · #804)
const summary = (unread: number) => ({ risk: 2, opportunity: 3, unread } as RadarSummary);
let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.spyOn(authApi, "me").mockResolvedValue({ email: "openapi@tourlint.kr" } as AccountView);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const bell = () => host.querySelector(".notification-link")!;

it("🔴 미확인 알림이 있으면 종 옆에 건수를 붙이고, 확인 처리 알림을 받으면 다시 센다", async () => {
  const count = vi.spyOn(radarApi, "summary").mockResolvedValue(summary(5));
  await act(async () => root.render(<AppHeader />));
  expect(bell().querySelector(".notification-count")?.textContent).toBe("5");
  expect(bell().getAttribute("aria-label")).toBe("알림 · 확인하지 않은 알림 5건");

  count.mockResolvedValue(summary(0));
  await act(async () => announceNotificationsChanged());
  expect(bell().querySelector(".notification-count")).toBeNull();
  expect(bell().getAttribute("aria-label")).toBe("알림");
});

it("건수를 못 읽으면 숫자 없이 둔다", async () => {
  vi.spyOn(radarApi, "summary").mockRejectedValue(new Error("offline"));
  await act(async () => root.render(<AppHeader />));
  expect(bell().querySelector(".notification-count")).toBeNull();
});
