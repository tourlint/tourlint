// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findForbidden, visibleText } from "./screen-words";
import { planApi, type Finding, type PlanPlace, type PlanPlaces, type ProductDetail, type RadarNotification, type RegionSignal, type RunSummary, type TodayBrief } from "./api";
import { AuditBasis } from "../components/audit-basis";
import { FindingsSection, SummaryCard } from "../(app)/products/[productId]/audit-result";
import { PlacePicker } from "../(app)/products/[productId]/plan/place-picker";
import RadarPage, { NotificationCard, QuietRegionRow, RegionNewsCard, TodayBriefResult, batchRows } from "../(app)/radar/page";

// 라우터는 실제처럼 늘 같은 객체다 — 렌더마다 새로 주면 레이더의 효과가 끝없이 다시 돈다
const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

/**
 * 화면 말 낱말 검사를 검수 결과 · 장소 담기 · 오늘 할 일 · 레이더 근거 줄까지 넓힌다 (NF-US-008 · UI-CM-040).
 * 근거 영역(`data-evidence`)은 접지 않고 펼쳐 두되 검사에서 뺀다 — 10단계의 「조회 시각 · 데이터 지문 ·
 * 규칙셋」은 그대로 보인다. 낱말 목록과 근거 칸 빼기는 `screen-words.spec` 이 본다.
 */

const run: RunSummary = {
  auditRunId: 193, productId: 67, executedAt: "2026-09-25T21:40:00+09:00", rulesetVersion: "1.2.9", isPartial: false,
  readinessScore: 85,
  scoreBreakdown: { formula: null, deduction: 15, weights: { BLOCKER: 25, ERROR: 10, WARNING: 4, UNVERIFIED: 3 }, scoredCounts: { blocker: 0, error: 0, warning: 3, unverified: 1 } },
  counts: { blocker: 0, error: 0, warning: 3, unverified: 1, dismissed: 0 },
  needsConfirmationCount: 1, targetCount: 14, failedCount: 0, releasable: true, releaseBlockedReason: null,
  settingSnapshot: { standardVersion: "2026.09", r07SpanHours: 6, r07MealMinutes: 90 },
  evidence: {
    fetchedAt: "2026-09-25T21:40:00+09:00", targetContentCount: 14, dataFingerprint: "3d8bbf5d", dataFingerprintFull: "3d8bbf5d0011",
    rulesetVersion: "1.2.9", ktoModifiedAt: "20260918143012", delayNotice: "공사 데이터는 당일 변경분이 익일 반영되므로 출발 임박 시 운영기관 최종 확인을 권장합니다", source: "출처: ⓒ한국관광공사",
  },
};

const item = (itemId: number, seq: number, place: string, start: string, end: string | null) =>
  ({ itemId, seq, start, end, place, itemType: "SIGHT", ktoContentId: String(100 + itemId), matchStatus: "CONFIRMED", mapx: 128.9, mapy: 37.79 });
const product = {
  productId: 67, name: "강릉 감성 2박 3일", dayCount: 1, ldongRegnCd: "51", ldongSignguCd: "150", startDate: "2026-11-17", nights: 0,
  days: [{ day: 1, items: [item(1, 1, "경포대", "10:00", "11:30"), item(2, 2, "오죽헌", "11:00", "12:30")] }],
} as unknown as ProductDetail;

const finding = (over: Partial<Finding>): Finding => ({
  findingId: 1, evidenceView: { aiNormalized: null, verdict: null }, ruleCode: "R03", ruleVersion: "1.0.0", severity: "ERROR",
  reasonCode: "TIME_OVERLAP", message: "경포대(10:00~11:30) 와 오죽헌(11:00~12:30) 가 30분 겹칩니다",
  target: { itemId: 1 }, targetSecondary: { itemId: 2 }, requiresExternal: false, externalSource: null, sourceBadge: "TOURLINT_VERDICT",
  needsConfirmation: false, dismissible: true, dismissedAt: null, dismissReason: null, confirmedAt: null, patches: [], ...over,
});
const noop = async (): Promise<void> => undefined;

afterEach(() => { vi.restoreAllMocks(); });

describe("검수 결과 — 요약 · 문제 카드", () => {
  it("🔴 만드는 쪽 말이 근거 영역 밖에 없다 — 근거 영역은 접지 않고 펼쳐 둔다", () => {
    const html = renderToStaticMarkup(<SummaryCard run={run} confirmationCount={1} />)
      + renderToStaticMarkup(
        <FindingsSection product={product} itemLabel={(id) => (id === 1 ? "경포대" : "오죽헌")} contentOf={() => null}
          selected={{}} onSelectPatch={() => undefined} onChanged={noop} busy={false}
          checkedCount={run.targetCount} fetchedAt={run.evidence.fetchedAt}
          findings={[
            finding({}),
            finding({ findingId: 2, ruleCode: "R08", severity: "ERROR", reasonCode: "TRAVEL_TIME_SHORT", message: "경포대 → 오죽헌 이동에 약 6분이 걸리는데 배정된 시간은 0분입니다. 6분이 모자랍니다.",
              requiresExternal: true, externalSource: "카카오모빌리티", sourceBadge: "EXTERNAL_REFERENCE" }),
          ]} />,
      );
    expect(findForbidden(html, false)).toEqual([]);
    // 가이드 10단계 — 점수 아래에 조회 시각 · 데이터 지문 · 규칙셋이 나온다(접힌 칸이 아니다)
    for (const label of ["조회 시각", "데이터 지문", "규칙셋"]) expect(html).toContain(label);
    expect(html).not.toContain("<details");
  });
});

describe("장소 담기", () => {
  it("🔴 기획 화면 기준(판정 말까지)으로 걸리는 낱말이 없다", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const place = { contentId: "100", title: "식당 예시", contentTypeId: 39, lcls1: "FD", lcls2: "FD01", firstImage: null, distanceM: 320, togetherRank: null, mapx: 128, mapy: 37 } as PlanPlace;
    vi.spyOn(planApi, "briefing").mockResolvedValue({ types: [], budget: "OK", region: { regnCd: "51", signguCd: null, name: "강원" }, events: null, accessible: null, pet: null, walks: null } as Awaited<ReturnType<typeof planApi.briefing>>);
    vi.spyOn(planApi, "events").mockResolvedValue({ items: [], window: { from: "2026-11-16", to: "2026-11-18" } });
    vi.spyOn(planApi, "walks").mockResolvedValue({ items: [], notice: "" });
    vi.spyOn(planApi, "places").mockResolvedValue({ items: [place], totalCount: 1, scope: { label: "근처" } } as PlanPlaces);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<PlacePicker product={product} onInserted={noop} initialDay={1} initialAnchorId={1} initialNearKind="MEAL" />));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(host.textContent).toContain("식당 예시");
    expect(findForbidden(host.innerHTML, true)).toEqual([]);
    await act(async () => root.unmount());
    host.remove();
  });
});

describe("오늘 할 일", () => {
  it("🔴 결과 · AI 가 못 했을 때 · 바뀐 정보 없는 상품 줄에 걸리는 낱말이 없다", () => {
    const brief: TodayBrief = {
      basisAt: "2026-09-26T05:00:04+09:00",
      todos: [
        { kind: "CHANGE", productId: 48, region: null, reason: "담은 곳 1곳의 관광정보가 바뀌었습니다.", action: "REAUDIT" },
        { kind: "NEWS", productId: null, region: { regnCd: "51", signguCd: "210", month: "2026-11" }, reason: "새로 등록된 곳이 2곳 있습니다.", action: "NEW_PLAN" },
      ],
      quiet: [{ productId: 49, text: "제주 1박 2일은 바뀐 정보가 없어요." }],
      incomplete: { reasonCode: "LLM_UNAVAILABLE", itemIds: [] },
    };
    const html = renderToStaticMarkup(
      <TodayBriefResult brief={brief} productNames={new Map([[48, "경주 1박 2일"]])} regionNames={{ regns: new Map([["51", "강원특별자치도"]]), signgus: new Map([["51:210", "속초시"]]) }} />,
    );
    expect(findForbidden(html, false)).toEqual([]);
  });
});

describe("레이더 — 화면 전체 · 근거 줄 · 알림 카드 · 관심 지역", () => {
  it("🔴 근거 칸 밖 레이더 화면 글자에 걸리는 낱말이 없다 — 근거 줄은 결과를 말로 적는다", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const risk = {
      notificationId: 3, kind: "RISK", condition: 1, productId: 7, productName: "강릉 2일", startDate: "2099-10-28",
      ktoContentId: "126508", placeName: "오죽헌", schedule: { dayNo: 1, startTime: "12:00" },
      changes: [{ label: "운영시간", before: "09:00~18:00", after: "09:00~17:00" }], current: [], modifiedOn: "2026-09-25",
      eventPeriod: null, overlapDays: [], what: "운영시간 정보가 바뀌었습니다.", impact: "1일차 12:00 일정입니다.",
      action: "다시 검수해 판정을 갱신하세요.", hidden: false, fingerprint: { from: "abcdef0123", to: "0123abcdef" },
      opportunity: null, verdictDiff: { added: [], removed: [], changed: [{ ruleCode: "R01", from: "WARNING", to: "BLOCKER" }] },
      dismissable: true, readAt: "2026-09-26T06:00:00+09:00", dismissedAt: null, createdAt: "2026-09-26T05:00:00+09:00",
    };
    const region = {
      region: { regnCd: "51", signguCd: "210" }, month: "2099-11",
      t1: { count: 1, byType: {}, window: { from: "2026-08-28", to: "2026-09-26" }, computedAt: "2026-09-26T05:00:00+09:00", keywordHits: [] },
      t2: { count: 3, byType: {}, window: { from: "2099-11-01", to: "2099-11-30" }, computedAt: "2026-09-26T05:00:00+09:00", keywordHits: [] },
      t3: null,
    };
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/v1/products")) return json({ content: [], totalPages: 1 });
      if (url.startsWith("/api/v1/notifications")) return json({ content: [risk], page: 0, size: 20, totalElements: 1, unreadCount: 0 });
      if (url === "/api/v1/settings") return json({ watchKeywords: ["커피"], watchRegions: [{ regnCd: "51", signguCd: "210", month: "2099-11" }] });
      if (url === "/api/v1/radar/region-signals") return json([region]);
      if (url === "/api/v1/radar/summary") {
        return json({
          risk: 1, opportunity: 0, unread: 0, affectedProducts: 1, changedContents: 1,
          lastBatchAt: "2026-09-26T05:00:04+09:00", nextBatchAt: "2026-09-29T05:00:00+09:00",
          lastBatch: { runAt: "2026-09-26T05:00:04+09:00", covered: "2026-09-25", status: "OK", itemCount: 177 },
        });
      }
      return json({ items: [] });
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<RadarPage />));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    const html = host.innerHTML;
    // 검사할 화면 글자가 실제로 있다 — 근거 칸만 그려 놓고 「걸리는 낱말 없음」으로 통과하지 않는다
    for (const shown of ["관심 키워드 · 관심 지역", "수요 신호", "오죽헌", "다시 검수한 판정", "이 지역으로 새 상품 기획"]) {
      expect(visibleText(html)).toContain(shown);
    }
    expect(findForbidden(html, false)).toEqual([]);
    const basis = [...host.querySelectorAll("dl[data-evidence]")].map((n) => n.textContent ?? "").join(" ");
    expect(basis).toContain("결과정상");
    expect(basis).toContain("조회 건수177건");
    expect(basis).not.toMatch(/\bOK\b/);
    await act(async () => root.unmount());
    host.remove();
  });

  it("근거 줄 한 줄 — 결과를 말로 적는다", () => {
    const html = renderToStaticMarkup(<AuditBasis rows={batchRows({ runAt: "2026-09-26T05:00:04+09:00", covered: "2026-09-25", status: "OK", itemCount: 177 })} />);
    expect(html).toContain("정상");
    expect(html).not.toContain(">OK<");
  });

  it("🔴 새 소식 · 바뀐 정보 카드와 관심 지역 카드 · 한 줄에 걸리는 낱말이 없다", () => {
    const card: RadarNotification = {
      notificationId: 1, kind: "OPPORTUNITY", condition: 5, productId: 7, productName: "강릉 2일", startDate: "2026-10-28",
      ktoContentId: "888001", placeName: "상우마을", schedule: null, changes: [], current: [], modifiedOn: "2026-09-25",
      eventPeriod: null, overlapDays: [], what: "일정의 빈 시간대에 넣을 만한 관광지가 새로 등록됐습니다.",
      impact: "2일차 12:00 ~ 14:30 빈 시간(150분)에 넣을 수 있어요. 머무는 시간은 약 60분으로 봤어요(알림 때 일정 기준).",
      action: "다른 일정과 겹치지 않아요. 이동시간은 넣은 뒤 다시 검수에서 확인해요.", hidden: false,
      fingerprint: { from: null, to: null }, dismissable: true, readAt: null, dismissedAt: null, createdAt: "2026-09-26T05:00:00+09:00",
      opportunity: { slot: { dayNo: 2, from: "12:00", to: "14:30", minutes: 150, dwellMinutes: 60 }, slotMissing: null, precheck: null, travelSource: null },
    };
    const risk: RadarNotification = {
      ...card, notificationId: 2, kind: "RISK", condition: 1, placeName: "오죽헌", what: "운영시간 정보가 바뀌었습니다.",
      impact: "1일차 12:00 일정입니다.", action: "다시 검수해 판정을 갱신하세요.", fingerprint: { from: "abcdef0123", to: "0123abcdef" },
      opportunity: null, verdictDiff: { added: [], removed: [], changed: [{ ruleCode: "R01", from: "WARNING", to: "BLOCKER" }] },
    };
    const signal: RegionSignal = {
      region: { regnCd: "51", signguCd: "210" }, month: "2026-11",
      t1: { count: 1, byType: {}, window: { from: "2026-08-28", to: "2026-09-26" }, computedAt: "2026-09-26T05:00:00+09:00", keywordHits: [] },
      t2: { count: 3, byType: {}, window: { from: "2026-11-01", to: "2026-11-30" }, computedAt: "2026-09-26T05:00:00+09:00", keywordHits: [] },
      t3: { count: 1120000, basisMonth: "2025-11", source: "빅데이터", computedAt: "2026-09-26T05:00:00+09:00" },
    };
    const quiet: RegionSignal = { ...signal, t1: { ...signal.t1!, count: 0 }, t2: { ...signal.t2!, count: 0 } };
    const html = renderToStaticMarkup(<NotificationCard notification={card} onDismiss={noop} />)
      + renderToStaticMarkup(<NotificationCard notification={risk} onDismiss={noop} />)
      + renderToStaticMarkup(<RegionNewsCard signal={signal} regionName="강원특별자치도 속초시" />)
      + renderToStaticMarkup(<ul><QuietRegionRow signal={quiet} regionName="강원특별자치도 속초시" /></ul>);
    expect(findForbidden(html, false)).toEqual([]);
  });
});
