// @vitest-environment jsdom
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentApi, auditApi, contentApi, planApi, productApi,
  type ContentDetail, type Finding, type ProductDetail, type ProductItem, type RunSummary, type UnverifiedItem,
} from "../../../lib/api";
import { AuditResult, FindingsSection, SummaryCard } from "./audit-result";
import { PlacePicker } from "./plan/place-picker";
import { CheckQuestionsCard } from "./check-questions-card";

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

// 출처 배지 · 변경금지 · 원문 표기 (FR-CM-010 · 011 · 012 · UI-S3-012 · UI-ST-005)

const detail = (over: Partial<ContentDetail>): ContentDetail => ({
  contentId: "2868839", fetchedAt: "2026-09-26T14:00:00+09:00", hidden: false, officialName: "가람집옹심이",
  homepageUrl: null, contact: { tel: "033-000-0000" }, ktoRaw: { restdatefood: "매주 화요일" }, ktoModifiedTime: null,
  unavailableReason: null, contentTypeId: 39, mapx: null, mapy: null, lclsSystm1: null, lclsSystm2: null, lclsSystm3: null,
  cpyrhtDivCd: null, ...over,
});
const finding = {
  findingId: 1, severity: "BLOCKER", ruleCode: "R01", ruleVersion: "1.0.5", reasonCode: "CLOSED_ON_VISIT", message: "방문일이 쉬는 날입니다",
  target: { itemId: 11, dayNo: 1, startTime: "13:00", seq: 3 }, targetSecondary: null, requiresExternal: false, externalSource: null,
  sourceBadge: "TOURLINT_VERDICT", needsConfirmation: false, dismissible: false, dismissedAt: null, dismissReason: null,
  confirmedAt: null, patches: [], evidenceView: { aiNormalized: null, verdict: {} },
} as Finding;

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

/** 판단 근거를 펼친 뒤 「공사 원문」 칸 */
async function openEvidence(content: ContentDetail): Promise<HTMLElement> {
  vi.spyOn(contentApi, "detail").mockResolvedValue(content);
  // 콘텐츠마다 한 번 받은 것은 다시 부르지 않으니(5-12) 테스트마다 다른 번호로 연다
  const id = `${content.contentId}-${Math.random()}`;
  await act(async () => root.render(
    <FindingsSection product={{ days: [] } as unknown as ProductDetail} findings={[finding]} checkedCount={1} fetchedAt="2026-09-26T14:00:00"
      itemLabel={() => "가람집옹심이"} contentOf={() => id} selected={{}} onSelectPatch={() => {}} onChanged={async () => {}} busy={false} />,
  ));
  await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "판단 근거 보기")!.click());
  const block = [...host.querySelectorAll("section")].find((s) => s.textContent?.startsWith("공사 원문"));
  expect(block).toBeDefined();
  return block!;
}

describe("판단 근거의 공사 원문", () => {
  it("🔴 원문의 <br> 은 줄바꿈으로 되돌리고 태그 글자를 보이지 않는다 (UI-S3-012)", async () => {
    const block = await openEvidence(detail({ ktoRaw: { opentime: "06:00~23:00<br>※ 점포별 상이함" }, contentTypeId: 38 }));
    expect(block.querySelector("dd")?.textContent).toBe("06:00~23:00\n※ 점포별 상이함");
    expect(block.textContent).not.toContain("<br>");
  });

  it("🔴 제3유형(Type3)이면 공사 원문 배지에 「변경금지」를 붙인다 (FR-CM-011)", async () => {
    const block = await openEvidence(detail({ cpyrhtDivCd: "Type3" }));
    expect(block.querySelector(".rounded-full")?.textContent).toBe("공사 원문변경금지");
  });

  it("Type1 · 값 없음에는 붙이지 않는다 (EI-KT-017)", async () => {
    const block = await openEvidence(detail({ cpyrhtDivCd: "Type1" }));
    expect(block.textContent).not.toContain("변경금지");
  });

  it("🔴 못 읽은 까닭은 사유코드 대신 조회 실패 / 정보 없음으로 적는다 (FR-CM-012 · UI-ST-005)", async () => {
    const failed = await openEvidence(detail({ ktoRaw: {}, unavailableReason: "KTO_FETCH_FAILED" }));
    expect(failed.textContent).toContain("조회 실패 — 관광정보를 불러오지 못했습니다.");
    expect(failed.textContent).not.toContain("KTO_FETCH_FAILED");
  });
});

describe("배지가 없던 블록 (FR-CM-010)", () => {
  const run: RunSummary = {
    auditRunId: 3, productId: 42, executedAt: "2026-09-26T10:00:00+09:00", rulesetVersion: "1.2.9", isPartial: false,
    readinessScore: 85, scoreBreakdown: { formula: null, deduction: 15, weights: { BLOCKER: 25, ERROR: 10, WARNING: 4, UNVERIFIED: 3 } },
    counts: { blocker: 0, error: 0, warning: 3, unverified: 1, dismissed: 0 }, needsConfirmationCount: 1,
    targetCount: 14, failedCount: 0, releasable: true, releaseBlockedReason: null, settingSnapshot: null,
    evidence: { fetchedAt: "2026-09-26T10:00:00+09:00", targetContentCount: 14, dataFingerprint: null, dataFingerprintFull: null,
      rulesetVersion: "1.2.9", ktoModifiedAt: null, delayNotice: "안내", source: "출처" },
  };

  it("🔴 요약 카드에 TourLint 판정 배지", () => {
    expect(renderToStaticMarkup(<SummaryCard run={run} confirmationCount={1} />)).toContain("TourLint 판정");
  });

  it("🔴 직접 확인할 곳의 줄마다 TourLint 판정 배지", async () => {
    const lighthouse: UnverifiedItem = {
      findingId: 91, contentid: "126274", placeLabel: "주문진 등대", reason: "주문진 등대 — 운영시간을 확인할 수 없습니다",
      reasonCode: "HOURS_UNCERTAIN", location: { dayNo: 3, seq: 4, startTime: "14:30" }, confirmedAt: null,
      excludedFromScore: false, note: null, targetItemId: 31,
    };
    vi.spyOn(productApi, "detail").mockResolvedValue({
      productId: 42, name: "강릉", days: [], releasedAt: null, startDate: "2026-11-17", nights: 2,
      region: { regnName: "강원특별자치도", signguName: "강릉시" }, composition: { manual: 14, picker: 0, excluded: 0 },
    } as unknown as ProductDetail);
    vi.spyOn(auditApi, "listRuns").mockResolvedValue({ totalCount: 1, runs: [{ auditRunId: 3, executedAt: run.executedAt, isPartial: false, readinessScore: 85, isCurrent: true }] });
    vi.spyOn(auditApi, "getRun").mockResolvedValue(run);
    vi.spyOn(auditApi, "getFindings").mockResolvedValue({ content: [], totalElements: 0 });
    vi.spyOn(auditApi, "getUnverified").mockResolvedValue({ totalCount: 2, items: [lighthouse, { ...lighthouse, findingId: 92, targetItemId: 32 }] });
    vi.spyOn(auditApi, "availability").mockResolvedValue({ available: true, reasonCode: null, resumesAt: null });
    vi.spyOn(agentApi, "checkQuestions").mockResolvedValue({ places: [], incomplete: null });
    await act(async () => root.render(<AuditResult productId={42} />));
    const rows = [...host.querySelectorAll("#audit-confirmations ul > li")];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.textContent).toContain("TourLint 판정");
  });
});

describe("전화로 물어볼 내용 (FR-CM-010)", () => {
  it("🔴 AI 가 정리한 결과에 AI 정규화 배지", async () => {
    vi.spyOn(agentApi, "checkQuestions").mockResolvedValue({
      places: [{ findingIds: [91], itemId: 31, visit: { dayNo: 3, date: "2026-11-19", start: "14:30" }, tel: "033-640-4000", questions: ["그날 여나요?"] }],
      incomplete: null,
    });
    await act(async () => root.render(<CheckQuestionsCard runId={3} itemLabel={() => "주문진 등대"} />));
    expect(host.textContent).not.toContain("AI 정규화");
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "물어볼 내용 만들기")!.click());
    expect(host.textContent).toContain("AI 정규화");
  });
});

describe("장소 담기 예산 안내 (FR-CM-012)", () => {
  it("🔴 「공사 데이터 조회량」이 아니라 「관광정보 조회」라고 적는다", async () => {
    vi.spyOn(planApi, "briefing").mockResolvedValue({ types: [], budget: "PAUSED", region: { regnCd: "51", signguCd: null, name: "강원" }, events: null, accessible: null, pet: null, walks: null });
    vi.spyOn(planApi, "events").mockResolvedValue({ items: [], window: { from: "2026-10-13", to: "2026-10-14" } });
    vi.spyOn(planApi, "walks").mockResolvedValue({ items: [], notice: "" });
    const item = { itemId: 1, place: "경포대", seq: 1, mapx: 128, mapy: 37, matchStatus: "CONFIRMED" } as ProductItem;
    await act(async () => root.render(<PlacePicker product={{ productId: 42, dayCount: 1, ldongRegnCd: "51", days: [{ day: 1, items: [item] }] } as ProductDetail} onInserted={async () => {}} />));
    expect(host.textContent).toContain("오늘 쓸 수 있는 관광정보 조회를 다 써서");
    expect(host.textContent).not.toContain("공사 데이터");
  });
});
