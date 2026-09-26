// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditApi, patchApi, productApi, type Finding, type PatchPreview, type ProductDetail, type ProductItem, type RunSummary } from "../../../lib/api";
import { AuditResult, chosenPatches } from "./audit-result";

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

// 수정안 미리보기 머리 — 고른 수정안 목록 · 줄마다 해제 · 충돌 쌍 · 충돌 없음 (UI-S4-003 ~ 005 · FR-PA-006 · 007)

const a: ProductItem = { itemId: 1, seq: 1, start: "10:00", end: "11:30", place: "강릉 경포대", itemType: "SIGHT", ktoContentId: null, matchStatus: "CONFIRMED", mapx: null, mapy: null };
const b: ProductItem = { ...a, itemId: 2, seq: 2, start: "11:00", end: "12:30", place: "강릉 오죽헌·시립박물관" };
const product = {
  productId: 42, name: "강릉 2박 3일", releasedAt: null, startDate: "2026-11-17", nights: 2, plannedAt: "2026-09-26",
  region: { regnName: "강원특별자치도", signguName: "강릉시" }, composition: { manual: 2, picker: 0, excluded: 0 },
  days: [{ day: 1, items: [a, b] }],
} as unknown as ProductDetail;
const base = {
  ruleVersion: "1.0.0", reasonCode: "X", targetSecondary: null, requiresExternal: false, externalSource: null,
  sourceBadge: "TOURLINT_VERDICT", needsConfirmation: false, dismissible: true, dismissedAt: null, dismissReason: null,
  confirmedAt: null, evidenceView: { aiNormalized: null, verdict: {} },
} as const;
// 가이드 11-1 — 겹침 카드의 「오죽헌 → 12:00 – 13:30」 과 이동 시간 카드의 순서 교환
const overlap = { ...base, findingId: 1, severity: "ERROR", ruleCode: "R03", message: "30분 겹칩니다",
  target: { itemId: 1, dayNo: 1, startTime: "10:00", seq: 1 },
  patches: [{ patchId: "p1", type: "TIME_SHIFT", targetItemId: 2, payload: { newStartTime: "12:00", newEndTime: "13:30" } }] } as unknown as Finding;
const travel = { ...base, findingId: 2, severity: "ERROR", ruleCode: "R08", message: "이동 6분이 부족합니다",
  target: { itemId: 2, dayNo: 1, startTime: "11:00", seq: 2 },
  patches: [{ patchId: "q1", type: "REORDER", targetItemId: 1, payload: { swapWithItemId: 2 } }] } as unknown as Finding;
const run: RunSummary = {
  auditRunId: 5, productId: 42, executedAt: "2026-09-26T10:00:00+09:00", rulesetVersion: "1.2.9", isPartial: false,
  readinessScore: 60, scoreBreakdown: { formula: null, deduction: 40, weights: { BLOCKER: 25, ERROR: 10, WARNING: 4, UNVERIFIED: 3 } },
  counts: { blocker: 0, error: 2, warning: 0, unverified: 0, dismissed: 0 }, needsConfirmationCount: 0,
  targetCount: 2, failedCount: 0, releasable: true, releaseBlockedReason: null, settingSnapshot: null,
  evidence: { fetchedAt: "2026-09-26T10:00:00+09:00", targetContentCount: 2, dataFingerprint: null, dataFingerprintFull: null,
    rulesetVersion: "1.2.9", ktoModifiedAt: null, delayNotice: "안내", source: "출처" },
};
const row = (id: number, place: string, start: string, end: string) => ({ id, dayNo: 1, seq: id, startTime: start, endTime: end, placeLabel: place, itemType: "SIGHT" });
const conflicting: PatchPreview = {
  previewToken: "t1", skipped: [],
  conflict: { hasConflict: true, pairs: [{ kind: "SAME_ITEM", a: { findingId: 1, patchId: "p1" }, b: { findingId: 2, patchId: "q1" }, message: "같은 일정 항목을 두 수정안이 함께 바꿉니다. 하나만 선택해 주세요." }] },
  before: [row(1, a.place, "10:00", "11:30"), row(2, b.place, "11:00", "12:30")],
  after: [row(1, a.place, "10:00", "11:30"), row(2, b.place, "12:00", "13:30")],
};
const clean: PatchPreview = { ...conflicting, previewToken: "t2", conflict: { hasConflict: false, pairs: [] } };

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(productApi, "detail").mockResolvedValue(product);
  vi.spyOn(auditApi, "listRuns").mockResolvedValue({ totalCount: 1, runs: [{ auditRunId: 5, executedAt: run.executedAt, isPartial: false, readinessScore: 60, isCurrent: true }] });
  vi.spyOn(auditApi, "getRun").mockResolvedValue(run);
  vi.spyOn(auditApi, "getFindings").mockResolvedValue({ content: [overlap, travel], totalElements: 2 });
  vi.spyOn(auditApi, "getUnverified").mockResolvedValue({ totalCount: 0, items: [] });
  vi.spyOn(auditApi, "availability").mockResolvedValue({ available: true, reasonCode: null, resumesAt: null });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
async function pick(text: string) {
  const label = [...host.querySelectorAll("label.patch-option")].find((l) => l.textContent?.includes(text));
  expect(label, text).toBeDefined();
  await act(async () => label!.querySelector("input")!.click());
}
const chosenRows = () => [...host.querySelectorAll("[data-chosen-patches] li")].map((li) => li.textContent);

describe("미리보기 머리", () => {
  it("🔴 고른 수정안을 규칙 이름 · 설명으로 적고, 충돌이면 어느 두 수정안인지 「A ↔ B」로 지목한다", async () => {
    vi.spyOn(patchApi, "preview").mockResolvedValue(conflicting);
    await act(async () => root.render(<AuditResult productId={42} />));
    await pick("방문 시간 변경");
    await pick("두 장소의 방문 순서·시간 교환");
    await act(async () => button("미리보기")!.click());

    expect(chosenRows()).toEqual([
      "일정 시간 겹침방문 시간 변경 · 강릉 오죽헌·시립박물관 → 1일차 · 12:00 – 13:30해제",
      "이동 시간두 장소의 방문 순서·시간 교환 · 강릉 경포대 ↔ 강릉 오죽헌·시립박물관해제",
    ]);
    const conflict = host.querySelector("[data-conflict]");
    // 가이드 11-1 문장은 그대로다
    expect(conflict?.textContent).toContain("선택한 수정안 사이에 충돌이 있습니다");
    expect(conflict?.textContent).toContain("일정 시간 겹침: 방문 시간 변경(강릉 오죽헌·시립박물관) ↔ 이동 시간: 두 장소의 방문 순서·시간 교환(강릉 경포대)");
    expect(button("확정하고 재검수")?.disabled).toBe(true);
    expect(button("선택 해제")).toBeDefined();
  });

  it("🔴 줄마다 [해제]하면 남은 선택으로 다시 미리보고, 충돌이 없으면 「충돌 없음」을 적는다", async () => {
    const preview = vi.spyOn(patchApi, "preview").mockResolvedValueOnce(conflicting).mockResolvedValue(clean);
    await act(async () => root.render(<AuditResult productId={42} />));
    await pick("방문 시간 변경");
    await pick("두 장소의 방문 순서·시간 교환");
    await act(async () => button("미리보기")!.click());

    const releaseTravel = [...host.querySelectorAll("[data-chosen-patches] li")].find((li) => li.textContent?.startsWith("이동 시간"))!.querySelector("button")!;
    await act(async () => releaseTravel.click());
    expect(preview).toHaveBeenLastCalledWith(42, [{ findingId: 1, patchId: "p1" }]);
    expect(chosenRows()).toHaveLength(1);
    expect(host.querySelector("[data-conflict]")).toBeNull();
    expect(host.querySelector("[data-conflict-free]")?.textContent).toBe("수정안 간 충돌 검사: 충돌 없음");
    expect(button("확정하고 재검수")?.disabled).toBe(false);
    expect(host.textContent).toContain("수정안 1개 선택됨");
  });

  it("마지막 하나를 해제하면 미리보기를 닫는다", async () => {
    const preview = vi.spyOn(patchApi, "preview").mockResolvedValue(clean);
    await act(async () => root.render(<AuditResult productId={42} />));
    await pick("방문 시간 변경");
    await act(async () => button("미리보기")!.click());
    await act(async () => button("해제")!.click());
    expect(preview).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-chosen-patches]")).toBeNull();
  });
});

it("지금 결과에 없는 선택은 이름을 지어내지 않는다", () => {
  expect(chosenPatches({ 9: "x" }, [overlap], product)).toEqual([{ findingId: 9, patchId: "x", rule: "수정안", text: "고른 수정안", short: "고른 수정안" }]);
  expect(chosenPatches({ 1: "p1" }, [overlap], product)[0]?.text).toBe("방문 시간 변경 · 강릉 오죽헌·시립박물관 → 1일차 · 12:00 – 13:30");
});
