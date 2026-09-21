import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotificationCard, reauditLine } from "./page";
import { findForbidden } from "../../lib/screen-words";
import type { RadarNotification } from "../../lib/api";

const base: RadarNotification = {
  notificationId: 1, kind: "RISK", condition: 1, productId: 7, productName: "강릉 2일",
  startDate: "2026-10-28", ktoContentId: "126508", placeName: "강릉 오죽헌·시립박물관",
  schedule: { dayNo: 1, startTime: "12:00" }, changes: [], current: [], modifiedOn: null, eventPeriod: null, overlapDays: [],
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

  it("🔴 무엇이 어떻게 바뀌었는지를 전 → 후로 보인다 (UI-S7-004 · #703)", () => {
    const html = renderToStaticMarkup(<NotificationCard onDismiss={noop} notification={{
      ...base, what: "운영시간 정보가 바뀌었습니다.",
      changes: [{ label: "운영시간", before: "09:00~18:00", after: "09:00~17:00" }],
    }} />);
    expect(html).toContain("data-changes");
    expect(html).toContain("09:00~18:00");
    expect(html).toContain("09:00~17:00");
    // 바뀐 것이 있으면 지금 값을 또 적지 않는다
    expect(html).not.toContain("data-current");
  });

  it("견줄 이전 검수가 없으면 지금 관광정보를 보인다", () => {
    const html = renderToStaticMarkup(<NotificationCard onDismiss={noop} notification={{
      ...base, current: [{ label: "휴무일", value: "월" }, { label: "운영시간", value: "10:30~21:30" }],
    }} />);
    expect(html).toContain("지금 관광정보");
    expect(html).toContain("휴무일 월 · 운영시간 10:30~21:30");
  });

  it("관광정보가 수정된 날을 사용자 말로 적는다", () => {
    const html = renderToStaticMarkup(<NotificationCard onDismiss={noop} notification={{ ...base, modifiedOn: "2026-09-18" }} />);
    expect(html).toContain("9월 18일에 수정됐어요");
  });

  it("🔴 알림 뒤에 다시 검수했으면 「다시 검수하세요」 대신 지금 결과를 말한다 (#703)", () => {
    const audit = { executedAt: "2026-09-15T09:30:00+09:00", readinessScore: 66, counts: { blocker: 0, error: 1, warning: 3, unverified: 2 } };
    const html = renderToStaticMarkup(<NotificationCard onDismiss={noop} audit={audit} notification={base} />);
    expect(html).toContain("알림 뒤에 다시 검수했어요 · 지금 66점 · 차단 0 · 오류 1");
    expect(html).not.toContain(base.action);
    expect(html).toContain("검수 결과 보기");
  });

  it("알림보다 먼저 한 검수는 다시 검수한 것이 아니다", () => {
    const before = { executedAt: "2026-09-14T09:00:00+09:00", readinessScore: 92, counts: { blocker: 0, error: 0, warning: 2, unverified: 0 } };
    expect(reauditLine(base.createdAt, before)).toBeNull();
    const html = renderToStaticMarkup(<NotificationCard onDismiss={noop} audit={before} notification={base} />);
    expect(html).toContain(base.action);
    expect(html).toContain("다시 검수");
    expect(html).not.toContain("검수 결과 보기");
  });

  it("부분 검수면 점수 대신 그렇게 적는다 · 새 소식에는 붙이지 않는다", () => {
    const partial = { executedAt: "2026-09-16T00:00:00+09:00", readinessScore: null, counts: { blocker: 0, error: 0, warning: 0, unverified: 0 } };
    expect(reauditLine(base.createdAt, partial)).toContain("점수 없음(부분 검수)");
    const news = renderToStaticMarkup(<NotificationCard onDismiss={noop} audit={partial} notification={{ ...base, kind: "OPPORTUNITY" }} />);
    expect(news).not.toContain("알림 뒤에 다시 검수했어요");
  });
});
