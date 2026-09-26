// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentApi, auditApi, productApi, type CheckQuestionPlace, type ProductDetail, type RunSummary, type UnverifiedItem } from "../../../lib/api";
import { AuditResult } from "./audit-result";
import { CheckQuestionsCard } from "./check-questions-card";

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

// 검수 에이전트 카드 — 안내 한 줄 · 「전화로 물어볼 내용 · N곳」 · 곳마다 확인했어요 · AI 를 못 쓸 때 (UI-S3-036 · 037 · FR-AG-005)

const lighthouse: CheckQuestionPlace = {
  findingIds: [91, 93], itemId: 31, visit: { dayNo: 3, date: "2026-11-19", start: "14:30" }, tel: "033-640-4000",
  questions: ["11월 19일 14시 30분에 여나요?", "몇 시까지 들어갈 수 있나요?"],
};
const workshop: CheckQuestionPlace = { ...lighthouse, findingIds: [92], itemId: 32, tel: null, questions: ["체험 시간이 언제인가요?"] };
const row = (findingId: number, targetItemId: number, confirmedAt: true | null = null): UnverifiedItem => ({
  findingId, contentid: "126274", placeLabel: "주문진 등대", reason: "주문진 등대 — 운영시간을 확인할 수 없습니다",
  reasonCode: "HOURS_UNCERTAIN", location: { dayNo: 3, seq: 4, startTime: "14:30" }, confirmedAt, excludedFromScore: false, note: null, targetItemId,
});

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const button = (text: string) => [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === text);
const labels = (id: number | null) => (id === 31 ? "주문진 등대" : "공예 체험장");
async function make(items: UnverifiedItem[] = [], onChanged = async () => {}) {
  await act(async () => root.render(<CheckQuestionsCard runId={7} itemLabel={labels} items={items} onChanged={onChanged} />));
  await act(async () => button("물어볼 내용 만들기")[0]!.click());
}

describe("안내와 결과 (UI-S3-036 · 037)", () => {
  it("🔴 누르기 전에 안내 한 줄과 [물어볼 내용 만들기]가 있다", async () => {
    await act(async () => root.render(<CheckQuestionsCard runId={7} itemLabel={labels} />));
    expect(host.textContent).toContain("전화로 물어볼 내용을 정리해 드려요 · 어디에 무엇을 물어볼지 한 번에 볼 수 있어요");
    expect(button("물어볼 내용 만들기")).toHaveLength(1);
  });

  it("🔴 결과 제목에 곳 수를 적고 곳마다 [질문 복사] · [확인했어요]를 둔다", async () => {
    vi.spyOn(agentApi, "checkQuestions").mockResolvedValue({ places: [lighthouse, workshop], incomplete: null });
    await make();
    expect(host.textContent).toContain("전화로 물어볼 내용 · 2곳");
    expect(button("질문 복사")).toHaveLength(2);
    expect(button("확인했어요")).toHaveLength(2);
    expect(host.textContent).toContain("확인한 내용에 맞게 일정을 고치면, 다시 검수할 때 반영돼요.");
    // 전화번호가 없는 곳은 안내 문장 (FR-AG-021)
    expect(host.querySelector('[data-place="32"]')?.textContent).toContain("등록된 전화번호가 없어요. 지역 관광안내소에 물어보세요.");
  });

  it("🔴 [확인했어요]는 그 곳의 확인 필요 항목을 목록 버튼과 같은 확인 API 로 적고 목록을 다시 읽는다", async () => {
    vi.spyOn(agentApi, "checkQuestions").mockResolvedValue({ places: [lighthouse], incomplete: null });
    const confirm = vi.spyOn(auditApi, "confirmFinding").mockResolvedValue(undefined);
    const changed = vi.fn(async () => {});
    await make([row(91, 31), row(93, 31)], changed);
    await act(async () => button("확인했어요")[0]!.click());
    expect(confirm.mock.calls.map(([id]) => id).sort()).toEqual([91, 93]);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("그 곳 항목이 모두 확인됐으면 「확인함」으로 막는다", async () => {
    vi.spyOn(agentApi, "checkQuestions").mockResolvedValue({ places: [lighthouse], incomplete: null });
    await make([row(91, 31, true), row(93, 31, true)]);
    expect(button("확인함")[0]?.disabled).toBe(true);
  });
});

describe("AI 로 정리하지 못했을 때 (FR-AG-005 · EX-AG-001 · 002)", () => {
  it("🔴 모델을 못 불러 끝난 곳이 없으면 「확인할 곳이 없어요」가 아니라 「지금은 AI로 정리할 수 없어요」와 까닭", async () => {
    vi.spyOn(agentApi, "checkQuestions").mockResolvedValue({ places: [], incomplete: { reasonCode: "LLM_UNAVAILABLE", itemIds: [31, 32] } });
    await make();
    const note = host.querySelector("[data-ai-unavailable]");
    expect(note?.textContent).toContain("지금은 AI로 정리할 수 없어요.");
    expect(note?.textContent).toContain("AI가 지금 응답하지 않아요.");
    expect(host.textContent).not.toContain("확인할 곳이 없어요");
    expect(host.textContent).not.toContain("LLM_UNAVAILABLE");
  });

  it("🔴 일부만 끝났으면 끝난 곳만 보이고 나머지 곳 수와 까닭을 적는다", async () => {
    vi.spyOn(agentApi, "checkQuestions").mockResolvedValue({ places: [lighthouse], incomplete: { reasonCode: "BUDGET_EXHAUSTED", itemIds: [32] } });
    await make();
    expect(host.textContent).toContain("전화로 물어볼 내용 · 1곳");
    expect(host.querySelector('[data-place="32"]')).toBeNull();
    const note = host.querySelector("[data-ai-unavailable]");
    expect(note?.textContent).toContain("나머지 1곳은 지금은 AI로 정리할 수 없어요.");
    expect(note?.textContent).toContain("오늘 쓸 수 있는 관광정보 조회를 모두 썼어요.");
  });

  it("🔴 실행 전에 막히면(429) 같은 문장에 서버가 준 까닭을 붙인다", async () => {
    vi.spyOn(agentApi, "checkQuestions").mockRejectedValue({
      status: 429, reasonCode: "BUDGET_EXHAUSTED",
      message: "오늘 쓸 수 있는 관광정보 조회를 모두 썼습니다. 내일 0시부터 다시 볼 수 있고, 확인 필요 목록은 지금도 볼 수 있습니다.",
    });
    await make();
    const note = host.querySelector("[data-ai-unavailable]");
    expect(note?.textContent).toContain("지금은 AI로 정리할 수 없어요.");
    expect(note?.textContent).toContain("내일 0시부터 다시 볼 수 있고");
  });

  it("정말 확인할 곳이 없으면 그렇게 말한다", async () => {
    vi.spyOn(agentApi, "checkQuestions").mockResolvedValue({ places: [], incomplete: null });
    await make();
    expect(host.textContent).toContain("전화로 확인할 곳이 없어요.");
    expect(host.querySelector("[data-ai-unavailable]")).toBeNull();
  });
});

it("🔴 결과 화면에서 카드의 [확인했어요]를 누르면 아래 목록의 줄도 「확인함」이 된다", async () => {
  const run: RunSummary = {
    auditRunId: 7, productId: 42, executedAt: "2026-09-26T10:00:00+09:00", rulesetVersion: "1.2.9", isPartial: false,
    readinessScore: 85, scoreBreakdown: { formula: null, deduction: 15, weights: { BLOCKER: 25, ERROR: 10, WARNING: 4, UNVERIFIED: 3 } },
    counts: { blocker: 0, error: 0, warning: 3, unverified: 1, dismissed: 0 }, needsConfirmationCount: 1,
    targetCount: 14, failedCount: 0, releasable: true, releaseBlockedReason: null, settingSnapshot: null,
    evidence: { fetchedAt: "2026-09-26T10:00:00+09:00", targetContentCount: 14, dataFingerprint: null, dataFingerprintFull: null,
      rulesetVersion: "1.2.9", ktoModifiedAt: null, delayNotice: "안내", source: "출처" },
  };
  vi.spyOn(productApi, "detail").mockResolvedValue({
    productId: 42, name: "강릉", days: [], releasedAt: null, startDate: "2026-11-17", nights: 2,
    region: { regnName: "강원특별자치도", signguName: "강릉시" }, composition: { manual: 14, picker: 0, excluded: 0 },
  } as unknown as ProductDetail);
  vi.spyOn(auditApi, "listRuns").mockResolvedValue({ totalCount: 1, runs: [{ auditRunId: 7, executedAt: run.executedAt, isPartial: false, readinessScore: 85, isCurrent: true }] });
  vi.spyOn(auditApi, "getRun").mockResolvedValue(run);
  vi.spyOn(auditApi, "getFindings").mockResolvedValue({ content: [], totalElements: 0 });
  vi.spyOn(auditApi, "availability").mockResolvedValue({ available: true, reasonCode: null, resumesAt: null });
  let confirmed = false;
  vi.spyOn(auditApi, "getUnverified").mockImplementation(async () => ({ totalCount: 1, items: [row(91, 31, confirmed ? true : null)] }));
  vi.spyOn(auditApi, "confirmFinding").mockImplementation(async () => { confirmed = true; });
  vi.spyOn(agentApi, "checkQuestions").mockResolvedValue({ places: [{ ...lighthouse, findingIds: [91] }], incomplete: null });

  await act(async () => root.render(<AuditResult productId={42} />));
  await act(async () => button("물어볼 내용 만들기")[0]!.click());
  expect(button("확인했어요")).toHaveLength(2); // 카드 하나 · 목록 하나
  await act(async () => button("확인했어요")[0]!.click());
  expect(button("확인했어요")).toHaveLength(0);
  expect(button("확인함")).toHaveLength(2);
});
