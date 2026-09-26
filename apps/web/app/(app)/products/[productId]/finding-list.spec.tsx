// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditApi, type Finding, type ProductDetail, type Severity } from "../../../lib/api";
import { FindingsSection, noFindingsText } from "./audit-result";
import { filterFindings } from "./finding-filter";

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

// 발견 항목 목록의 정렬 · 접기 · 무시한 카드 · 0건 문구 (FR-AU-066 · 067 · UI-S3-020 · 021 · 023 · UI-ST-011)

function finding(id: number, severity: Severity, over: Partial<Finding> = {}): Finding {
  return {
    findingId: id, severity, ruleCode: "R03", ruleVersion: "1.0.0", reasonCode: "X", message: `판정 문장 ${id}`,
    target: { itemId: null }, targetSecondary: null, requiresExternal: false, externalSource: null,
    sourceBadge: "TOURLINT_VERDICT", needsConfirmation: false, dismissible: severity !== "BLOCKER",
    dismissedAt: null, dismissReason: null, confirmedAt: null, patches: [],
    evidenceView: { aiNormalized: null, verdict: {} }, ...over,
  };
}
const at = (itemId: number, dayNo: number, startTime: string, seq = 1): Partial<Finding> => ({ target: { itemId, dayNo, startTime, seq } });

const product = { productId: 1, days: [] } as unknown as ProductDetail;
let host: HTMLDivElement; let root: Root;
const changed = vi.fn(async () => {});
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); changed.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

async function render(findings: Finding[]) {
  await act(async () => root.render(
    <FindingsSection product={product} findings={findings} checkedCount={12} fetchedAt="2026-09-26T14:05:31+09:00"
      itemLabel={(id) => `일정 ${id}`} contentOf={() => null} selected={{}} onSelectPatch={() => {}} onChanged={changed} busy={false} />,
  ));
}
const cards = () => [...host.querySelectorAll<HTMLLIElement>("li.finding-card")];
const cardIds = () => cards().map((li) => Number(/판정 문장 (\d+)/.exec(li.textContent ?? "")?.[1]));
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

// 같은 등급 안에서 규칙이 섞여 저장 순서가 일정 순서와 다르다
const mixed = [
  finding(1, "WARNING"), // 상품 전체 판정 — 대상이 없다
  finding(2, "WARNING", at(20, 2, "09:00")),
  finding(3, "ERROR", at(30, 2, "11:00")),
  finding(4, "WARNING", at(10, 1, "15:00")),
  finding(5, "ERROR", at(11, 1, "10:00")),
  finding(6, "WARNING", at(12, 1, "15:00", 3)),
];

describe("정렬 (FR-AU-066 · UI-S3-020)", () => {
  it("🔴 같은 등급 안에서 일차 · 시각 · 순번 순이고, 대상이 없는 상품 전체 판정은 등급 안 맨 뒤다", () => {
    expect(filterFindings(mixed, "ALL").map((f) => f.findingId)).toEqual([5, 3, 4, 6, 2, 1]);
    expect(filterFindings(mixed, "WARNING").map((f) => f.findingId)).toEqual([4, 6, 2, 1]);
  });

  it("🔴 「일정 순서」는 등급과 상관없이 일차 · 시각 순이다 — 무시한 항목은 그래도 맨 뒤", () => {
    const withDismissed = [...mixed, finding(7, "ERROR", { ...at(1, 1, "08:00"), dismissedAt: "2026-09-26", dismissReason: "고객 요청 사항" })];
    expect(filterFindings(withDismissed, "ALL", "SCHEDULE").map((f) => f.findingId)).toEqual([5, 4, 6, 2, 3, 1, 7]);
  });

  it("🔴 화면에서 「일정 순서」를 누르면 카드 순서가 바뀐다", async () => {
    await render(mixed);
    expect(cardIds()).toEqual([5, 3, 4, 6, 2, 1]);
    expect(button("등급 순")?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => button("일정 순서")!.click());
    expect(cardIds()).toEqual([5, 4, 6, 2, 3, 1]);
    expect(button("일정 순서")?.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("20건이 넘을 때 (FR-AU-067 · UI-S3-021)", () => {
  const errors = Array.from({ length: 3 }, (_, i) => finding(100 + i, "ERROR", at(100 + i, 1, `1${i}:00`)));
  const warnings = Array.from({ length: 15 }, (_, i) => finding(200 + i, "WARNING", at(200 + i, 2, `0${i % 10}:00`, i)));
  const unverified = Array.from({ length: 3 }, (_, i) => finding(300 + i, "UNVERIFIED", at(300 + i, 3, "09:00", i)));
  const many = [...errors, ...warnings, ...unverified];

  it("🔴 「전체」에서 주의 · 확인 불가를 접고 건수를 적은 펼치기 버튼만 둔다", async () => {
    await render(many);
    expect(many).toHaveLength(21);
    expect(cards()).toHaveLength(3);
    const toggles = [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].filter((b) => b.textContent?.includes("건"));
    expect(toggles.map((b) => b.textContent)).toEqual(["주의15건 펼치기", "확인 불가3건 펼치기"]);
    await act(async () => toggles[0]!.click());
    expect(cards()).toHaveLength(18);
    expect(toggles[0]!.getAttribute("aria-expanded")).toBe("true");
  });

  it("20건까지는 접지 않는다 — 가이드 상품(11건)은 그대로다", async () => {
    await render(many.slice(0, 20));
    expect(cards()).toHaveLength(20);
    expect(host.textContent).not.toContain("접어 두었어요");
    expect(host.querySelectorAll(".finding-group-toggle")).toHaveLength(0);
  });

  it("주의 필터로 보면 접지 않고 다 보인다 · 무시한 카드는 접힌 등급과 상관없이 남는다", async () => {
    await render([...many, finding(400, "WARNING", { dismissedAt: "2026-09-26", dismissReason: "고객 요청 사항" })]);
    expect(cards().filter((li) => li.dataset.dismissed === "true")).toHaveLength(1);
    await act(async () => button("주의15")!.click());
    expect(cards()).toHaveLength(15);
  });
});

describe("무시한 카드 (UI-S3-023)", () => {
  const dismissed = finding(9, "WARNING", { ruleCode: "R10", dismissedAt: "2026-09-26T15:00:00+09:00", dismissReason: "전화로 직접 확인함" });

  it("🔴 한 줄로 접어 등급 · 규칙 이름 · 무시됨 · 사유 · 무시 해제만 보이고, 누르면 본문을 편다", async () => {
    await render([finding(1, "ERROR", at(1, 1, "10:00")), dismissed]);
    const row = host.querySelector<HTMLLIElement>('li[data-dismissed="true"]')!;
    for (const text of ["주의", "상품 구성", "무시됨", "사유: 전화로 직접 확인함", "무시 해제"]) expect(row.textContent).toContain(text);
    expect(row.textContent).not.toContain("판정 문장 9");
    expect(row.textContent).not.toContain("판단 근거 보기");
    await act(async () => button("내용 보기")!.click());
    expect(row.textContent).toContain("판정 문장 9");
    expect(row.textContent).toContain("판단 근거 보기");
  });

  it("무시한 항목 필터에도 사유와 함께 남고 무시 해제를 누를 수 있다 (가이드 15-2)", async () => {
    const undo = vi.spyOn(auditApi, "undismissFinding").mockResolvedValue(undefined);
    await render([dismissed]);
    await act(async () => button("무시한 항목1")!.click());
    expect(host.textContent).toContain("사유: 전화로 직접 확인함");
    await act(async () => button("무시 해제")!.click());
    expect(undo).toHaveBeenCalledWith(9);
    expect(changed).toHaveBeenCalled();
  });
});

describe("발견 0건 (UI-ST-011)", () => {
  it("🔴 검수한 곳 수와 조회 시각을 함께 적는다", async () => {
    await render([]);
    expect(host.querySelector(".audit-empty")?.textContent).toBe("검수한 12곳에서 발견된 문제 0건 · 조회 2026-09-26 14:05");
    expect(noFindingsText(3, "2026-09-18T10:00:00")).toBe("검수한 3곳에서 발견된 문제 0건 · 조회 2026-09-18 10:00");
  });
});
