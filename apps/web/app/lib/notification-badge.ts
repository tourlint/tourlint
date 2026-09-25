// 헤더 알림 건수 (UI-CM-008 · #804).

/** 알림을 확인하거나 무시한 화면이 헤더에 다시 세라고 알린다 */
export const NOTIFICATIONS_CHANGED = "tourlint:notifications-changed";

export function announceNotificationsChanged(): void {
  window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
}

/** 종 옆에 붙일 숫자. 없거나 0 이면 붙이지 않는다 */
export function badgeText(unread: number | null): string | null {
  if (unread === null || unread <= 0) return null;
  return unread > 99 ? "99+" : String(unread);
}

/**
 * 화면에 보인 알림 중 처음 보는 것을 확인한 것으로 한다. 끝나면 헤더에 알린다.
 * 하나가 실패해도 나머지는 계속한다 — 못 한 것은 다음에 볼 때 다시 한다.
 */
export async function markShownRead(
  shown: readonly { notificationId: number; readAt: string | null }[],
  read: (id: number) => Promise<unknown>,
): Promise<number> {
  const unread = shown.filter((n) => n.readAt === null);
  if (unread.length === 0) return 0;
  await Promise.allSettled(unread.map((n) => read(n.notificationId)));
  announceNotificationsChanged();
  return unread.length;
}
