// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STANDARD_VERSION } from "@tourlint/shared";
import { auditApi, settingsApi, type SettingsView } from "../../lib/api";
import StandardPage from "./page";
import { STANDARD_HISTORY } from "./standard-history";

// 라우터는 실제처럼 늘 같은 객체다 — 렌더마다 새로 주면 효과가 끝없이 다시 돈다
const router = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const view = (meal: number, history: SettingsView["company"]["history"] = []): SettingsView => ({
  standard: { version: STANDARD_VERSION, weights: { BLOCKER: 25, ERROR: 10, WARNING: 4, UNVERIFIED: 3 }, r04Threshold: 3, r07SpanHours: 6, r07MealMinutes: 60 },
  company: { r07SpanHours: 6, r07MealMinutes: meal, updatedAt: null, history },
  watchKeywords: [], watchRegions: [], ops: { batchTime: "05:00", nextBatchAt: null },
});

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.spyOn(settingsApi, "get").mockResolvedValue(view(60));
  vi.spyOn(auditApi, "rules").mockResolvedValue({ rulesetVersion: "1.2.9", rules: [] });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const text = (sel: string): string => host.querySelector(sel)?.textContent ?? "";
const mealInput = (): HTMLInputElement => host.querySelectorAll<HTMLInputElement>('input[type="number"]')[1] as HTMLInputElement;
async function typeMeal(value: string): Promise<void> {
  const input = mealInput();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const saveButton = (): HTMLButtonElement => [...host.querySelectorAll("button")].find((b) => b.textContent === "저장") as HTMLButtonElement;

async function open(): Promise<void> {
  await act(async () => root.render(<StandardPage />));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("검수 기준 화면 머리와 표준 칸 (UI-S8-002 · UI-S8-003)", () => {
  it("🔴 맨 위에 표준 버전과 적용 중인 회사 기준 개수", async () => {
    await open();
    expect(text("[data-standard-status]")).toBe(`표준 ${STANDARD_VERSION} · 회사 기준 0개 적용 중`);
  });

  it("🔴 가중치 나열 대신 산식과 예시 계산", async () => {
    await open();
    expect(text("[data-score-formula]")).toBe("100 − (차단 25 · 오류 10 · 주의 4 · 확인 불가 3 × 건수), 0점 아래로 내려가지 않아요");
    expect(text("[data-score-example]")).toBe("예: 주의 3건 · 확인 불가 1건 → 100 − (4 × 3 + 3 × 1) = 85점");
  });

  it("🔴 표준 변경 이력이 페이지 아래에 있다 — 마지막 줄이 지금 표준이다", async () => {
    await open();
    expect(text("[data-standard-history]")).toContain(`표준 ${STANDARD_VERSION}`);
    expect(STANDARD_HISTORY[STANDARD_HISTORY.length - 1]?.version).toBe(STANDARD_VERSION);
  });
});

describe("회사 기준 — 체험 가이드 19단계 (UI-S8-006 · FR-OP-022)", () => {
  it("🔴 칸 아래 「표준과 같음 / 표준보다 엄격」과 느슨하게 보는 길 안내", async () => {
    await open();
    expect([...host.querySelectorAll("[data-strictness]")].map((n) => n.textContent)).toEqual(["표준과 같음", "표준과 같음"]);
    expect(text("[data-loosen-guide]")).toContain("검수 결과에서 해당 항목에 사유를 달아 무시");
  });

  it("45 는 막고 90 은 저장한다 — 저장하면 머리 개수와 변경 이력이 바뀌고, 60 으로 되돌리면 0개", async () => {
    const update = vi.spyOn(settingsApi, "update")
      .mockResolvedValueOnce(view(90, [{ at: "2026-09-26T14:00:00+09:00", field: "r07MealMinutes", from: 60, to: 90 }]))
      .mockResolvedValueOnce(view(60, [
        { at: "2026-09-26T14:00:00+09:00", field: "r07MealMinutes", from: 60, to: 90 },
        { at: "2026-09-26T14:05:00+09:00", field: "r07MealMinutes", from: 90, to: 60 },
      ]));
    await open();

    await typeMeal("45");
    expect(host.textContent).toContain("표준 60분보다 짧게는 정할 수 없어요");
    expect(saveButton().disabled).toBe(true);
    expect(host.querySelectorAll("[data-strictness]")).toHaveLength(1);

    await typeMeal("90");
    expect([...host.querySelectorAll("[data-strictness]")].map((n) => n.textContent)).toEqual(["표준과 같음", "표준보다 엄격"]);
    await act(async () => { saveButton().click(); });
    expect(update).toHaveBeenLastCalledWith({ r07SpanHours: 6, r07MealMinutes: 90 });
    expect(text("[data-standard-status]")).toBe(`표준 ${STANDARD_VERSION} · 회사 기준 1개 적용 중`);
    expect(host.textContent).toContain("최소 식사 시간 60 → 90");

    await typeMeal("60");
    await act(async () => { saveButton().click(); });
    expect(text("[data-standard-status]")).toBe(`표준 ${STANDARD_VERSION} · 회사 기준 0개 적용 중`);
    expect(host.textContent).toContain("최소 식사 시간 90 → 60");
  });
});
