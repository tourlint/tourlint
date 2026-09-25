// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATIONS_CHANGED, badgeText, markShownRead } from "./notification-badge";

// 헤더 알림 건수와 레이더의 확인 처리 (UI-CM-008 · #804)
describe("헤더 종 옆 숫자", () => {
  it("없거나 0 이면 붙이지 않고, 100 이상은 99+", () => {
    expect(badgeText(null)).toBeNull();
    expect(badgeText(0)).toBeNull();
    expect(badgeText(5)).toBe("5");
    expect(badgeText(120)).toBe("99+");
  });
});

describe("보인 알림의 확인 처리", () => {
  const heard = vi.fn();
  afterEach(() => {
    window.removeEventListener(NOTIFICATIONS_CHANGED, heard);
    heard.mockClear();
  });

  it("🔴 처음 보는 알림만 확인 처리하고 헤더에 다시 세라고 알린다", async () => {
    window.addEventListener(NOTIFICATIONS_CHANGED, heard);
    const read = vi.fn(async (id: number) => ({ id }));
    const count = await markShownRead(
      [{ notificationId: 1, readAt: null }, { notificationId: 2, readAt: "2026-09-25T20:00:00+09:00" }, { notificationId: 3, readAt: null }],
      read,
    );
    expect(count).toBe(2);
    expect(read.mock.calls.map(([id]) => id)).toEqual([1, 3]);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("하나가 실패해도 나머지를 하고 알린다", async () => {
    window.addEventListener(NOTIFICATIONS_CHANGED, heard);
    const read = vi.fn(async (id: number) => {
      if (id === 1) throw new Error("실패");
      return { id };
    });
    await markShownRead([{ notificationId: 1, readAt: null }, { notificationId: 2, readAt: null }], read);
    expect(read).toHaveBeenCalledTimes(2);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("다 확인한 목록이면 부르지도 알리지도 않는다", async () => {
    window.addEventListener(NOTIFICATIONS_CHANGED, heard);
    const read = vi.fn(async () => ({}));
    expect(await markShownRead([{ notificationId: 2, readAt: "2026-09-25T20:00:00+09:00" }], read)).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(heard).not.toHaveBeenCalled();
  });
});
