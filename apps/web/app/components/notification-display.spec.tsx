import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardShortcuts, ProductCard, ProductTable } from "./product-workspace";
import { NotificationCard } from "../(app)/radar/page";
import type { RadarNotification, RegionSignal } from "../lib/api";
import type { WorkspaceProduct } from "../lib/workspace";

// 알림 표시 (UI-S1-003 · UI-S1-010 · UI-S1-012 · UI-CM-008 · #804)
const noop = () => undefined;
const audit = {
  executedAt: "2026-09-25T19:25:00+09:00", readinessScore: 92, isPartial: false, releasable: true,
  counts: { blocker: 0, error: 0, warning: 1, unverified: 0 },
};
const reviewed: WorkspaceProduct = {
  productId: 7, name: "강릉 역사 2박 3일", startDate: "2099-09-28", nights: 2, plannedAt: "2026-09-20", latestAudit: audit,
};
const released: WorkspaceProduct = { ...reviewed, releasedAt: "2026-09-21T09:00:00+09:00" };

describe("알림이 있는 상품 — 목록 · 보드 카드 (UI-S1-003)", () => {
  it("🔴 확인하지 않은 알림이 있으면 구분해 보이고 그 수를 적는다", () => {
    const p = { ...reviewed, activeNotifications: 3, unreadNotifications: 2 };
    for (const html of [
      renderToStaticMarkup(<ProductCard product={p} onDelete={noop} />),
      renderToStaticMarkup(<ProductTable products={[p]} onDelete={noop} />),
    ]) {
      expect(html).toContain("새 알림 2");
      expect(html).toContain("has-alert");
    }
  });

  it("다 확인했으면 「알림 N」, 알림이 없으면 아무것도 붙이지 않는다", () => {
    expect(renderToStaticMarkup(
      <ProductCard product={{ ...reviewed, activeNotifications: 1, unreadNotifications: 0 }} onDelete={noop} />,
    )).toContain("알림 1");
    const none = renderToStaticMarkup(<ProductCard product={reviewed} onDelete={noop} />);
    expect(none).not.toContain("alert-chip");
    expect(none).not.toContain("has-alert");
  });
});

describe("출시함 칸 — 확인할 것 (UI-S1-010)", () => {
  it("🔴 알림 뒤에 다시 검수하지 않은 바뀐 정보가 있으면 「확인할 것」 과 「다시 검수」", () => {
    const html = renderToStaticMarkup(
      <ProductCard product={{ ...released, activeNotifications: 1, risksSinceAudit: 1 }} onDelete={noop} />,
    );
    expect(html).toContain("확인할 것 · 바뀐 정보 1건");
    expect(html).toContain('aria-label="강릉 역사 2박 3일 다시 검수"');
  });

  it("다시 검수했으면 출시일과 「검수 결과 보기」 로 돌아간다 — 알림 표시는 남는다", () => {
    const html = renderToStaticMarkup(
      <ProductCard product={{ ...released, activeNotifications: 1, risksSinceAudit: 0 }} onDelete={noop} />,
    );
    expect(html).toContain("2026-09-21 출시");
    expect(html).toContain('aria-label="강릉 역사 2박 3일 검수 결과 보기"');
    expect(html).toContain("알림 1");
  });
});

const window30 = { from: "2026-08-27", to: "2026-09-25" };
const region = (signguCd: string, t1: number): RegionSignal => ({
  region: { regnCd: "51", signguCd },
  month: "2026-11",
  t1: { count: t1, byType: {}, window: window30, computedAt: "2026-09-25T05:00:00+09:00", keywordHits: [] },
  t2: null,
  t3: null,
});

describe("보드 아래 바로 가기 (UI-S1-012)", () => {
  it("🔴 관심 지역 새 소식과 출시한 상품의 바뀐 정보를 센다 — 하나뿐이면 그곳으로 바로 보낸다", () => {
    const html = renderToStaticMarkup(
      <BoardShortcuts products={[{ ...released, risksSinceAudit: 2 }]} regionSignals={[region("150", 1), region("210", 0)]} />,
    );
    expect(html).toContain("관심 지역 새 소식 <strong>1건</strong>");
    expect(html).toContain('href="/products/new?regnCd=51&amp;signguCd=150&amp;month=2026-11&amp;origin=SIGNAL"');
    expect(html).toContain("출시한 상품의 바뀐 정보 <strong>2건</strong>");
    expect(html).toContain('href="/products/7"');
  });

  it("여럿이면 고를 수 있는 곳으로 보낸다", () => {
    const html = renderToStaticMarkup(
      <BoardShortcuts
        products={[{ ...released, risksSinceAudit: 1 }, { ...released, productId: 8, risksSinceAudit: 1 }]}
        regionSignals={[region("150", 1), region("210", 2)]}
      />,
    );
    expect(html).toContain('href="/radar#region-news"');
    expect(html).toContain('href="/review?status=RELEASED"');
    expect(html).toContain("출시한 상품의 바뀐 정보 <strong>2건</strong>");
  });

  it("출시하지 않은 상품 · 끝난 여행은 세지 않고, 0건이면 줄을 두지 않는다", () => {
    const html = renderToStaticMarkup(
      <BoardShortcuts
        products={[{ ...reviewed, risksSinceAudit: 3 }, { ...released, startDate: "2020-01-01", risksSinceAudit: 1 }]}
        regionSignals={[region("150", 0)]}
      />,
    );
    expect(html).toBe("");
  });
});

const notification = (readAt: string | null): RadarNotification => ({
  notificationId: 4, kind: "RISK", condition: 2, productId: 7, productName: "강릉 역사 2박 3일", startDate: "2026-09-28",
  ktoContentId: "3021124", placeName: null, schedule: null, changes: [], current: [], modifiedOn: "2026-09-24",
  eventPeriod: null, overlapDays: [], what: "공사에서 이 관광지의 표출이 중단됐습니다.", impact: "", action: "",
  hidden: true, fingerprint: { from: null, to: null }, dismissable: false, readAt, dismissedAt: null,
  createdAt: "2026-09-25T19:54:01+09:00",
});

describe("레이더 카드 — 처음 보는 알림 (UI-CM-008)", () => {
  it("🔴 확인하기 전 알림에는 「새로」를 붙이고, 확인한 알림에는 붙이지 않는다", () => {
    expect(renderToStaticMarkup(<NotificationCard notification={notification(null)} onDismiss={noop} />)).toContain("data-new");
    expect(renderToStaticMarkup(
      <NotificationCard notification={notification("2026-09-25T20:00:00+09:00")} onDismiss={noop} />,
    )).not.toContain("data-new");
  });
});
