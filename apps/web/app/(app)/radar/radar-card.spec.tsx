import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotificationCard } from "./page";
import { findForbidden } from "../../lib/screen-words";
import type { RadarNotification } from "../../lib/api";

const base: RadarNotification = {
  notificationId: 1, kind: "RISK", condition: 1, productId: 7, productName: "강릉 2일",
  startDate: "2026-10-28", ktoContentId: "126508", placeName: "강릉 오죽헌·시립박물관",
  what: "오죽헌 운영시간이 바뀌었어요", impact: "12:00 일정과 겹칠 수 있어요", action: "다시 검수해 확인하세요",
  hidden: false, fingerprint: { from: "abcdef0123", to: "0123abcdef" },
  dismissable: true, readAt: null, dismissedAt: null, createdAt: "2026-09-15T00:00:00.000Z",
};

const noop = async (): Promise<void> => undefined;

describe("바뀐 정보 카드 — 지문은 접힌 근거 칸 안에만 (UI-S7-003 · UI-CM-030)", () => {
  it("🔴 근거 칸 밖에 지문 · 만드는 쪽 말이 없다", () => {
    const html = renderToStaticMarkup(<NotificationCard notification={base} onDismiss={noop} />);
    // 지문 비교값은 data-evidence 안에 있어야 한다 — 밖으로 새면 findForbidden 이 "지문"을 잡는다
    expect(findForbidden(html, false)).toEqual([]);
  });

  it("🔴 어느 곳이 바뀌었는지 이름을 보인다 — 새 소식은 「새로 생긴 곳」 (#685)", () => {
    const risk = renderToStaticMarkup(<NotificationCard notification={base} onDismiss={noop} />);
    expect(risk).toContain("바뀐 곳");
    expect(risk).toContain("강릉 오죽헌·시립박물관");
    const news = renderToStaticMarkup(<NotificationCard notification={{ ...base, kind: "OPPORTUNITY", placeName: "상우마을" }} onDismiss={noop} />);
    expect(news).toContain("새로 생긴 곳");
    expect(news).toContain("상우마을");
  });

  it("이름을 못 읽은 카드는 지금처럼 문장만 보인다 — 빈 줄을 만들지 않는다", () => {
    const html = renderToStaticMarkup(<NotificationCard notification={{ ...base, placeName: null }} onDismiss={noop} />);
    expect(html).not.toContain("data-place-name");
    expect(html).toContain(base.what);
  });

  it("바뀐 정보는 [다시 검수], 새 소식은 [수정안 보기] 버튼을 보인다", () => {
    const risk = renderToStaticMarkup(<NotificationCard notification={base} onDismiss={noop} />);
    expect(risk).toContain("다시 검수");
    expect(risk).toContain("나중에");
    const news = renderToStaticMarkup(<NotificationCard notification={{ ...base, kind: "OPPORTUNITY" }} onDismiss={noop} />);
    expect(news).toContain("수정안 보기");
  });
});
