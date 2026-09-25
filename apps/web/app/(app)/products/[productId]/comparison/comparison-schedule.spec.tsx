// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { comparisonApi, type ComparisonResult, type PatchItem } from "../../../../lib/api";
import { ScheduleComparison } from "../schedule-compare";
import { ComparisonView } from "./comparison-view";

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

// 전후 비교의 바뀐 일정 (UI-S5-003 · FR-PA-042 · #806)
const row = (id: number, over: Partial<PatchItem> = {}): PatchItem => ({
  id, dayNo: 1, seq: id, startTime: "10:00", endTime: "11:00", placeLabel: `장소 ${id}`, itemType: "SIGHT", ...over,
});
const before = [row(1), row(2), row(3)];
const after = [row(1), row(2, { startTime: "12:00", endTime: "13:30" }), row(4, { seq: 3, placeLabel: "강릉 오죽헌" })];

describe("바뀐 일정 — 추가 · 제거 · 변경을 가른다", () => {
  it("🔴 색만이 아니라 글자로도 적는다", () => {
    const html = renderToStaticMarkup(
      <ScheduleComparison before={before} after={after} beforeTitle="반영 전" afterTitle="반영 후" emptyText="바뀐 일정이 없습니다." />,
    );
    expect(html.match(/data-status="removed"/g)).toHaveLength(1);
    expect(html.match(/data-status="added"/g)).toHaveLength(1);
    expect(html.match(/data-status="changed"/g)).toHaveLength(2);
    // 범례에도 같은 글자가 있다 — 줄 안에서 본다
    const doc = new DOMParser().parseFromString(html, "text/html");
    const tagOf = (status: string) => [...doc.querySelectorAll(`[data-status="${status}"]`)].map((li) => li.lastElementChild?.textContent);
    expect(tagOf("removed")).toEqual(["제거"]);
    expect(tagOf("added")).toEqual(["추가"]);
    expect(tagOf("changed")).toEqual(["변경", "변경"]);
    expect(html).not.toContain("바뀐 일정이 없습니다.");
  });

  it("🔴 앞 줄이 옮겨져 순번만 밀린 줄은 변경이 아니다", () => {
    const day1 = [row(1), row(2, { startTime: "12:00", endTime: "13:00" }), row(3, { startTime: "16:45", endTime: "17:45" })];
    // 2번 줄이 2일차로 옮겨 가고 3번 줄은 순번만 3 → 2 가 된다
    const moved = [row(1), row(2, { dayNo: 2, seq: 1, startTime: "10:30", endTime: "11:30" }), row(3, { seq: 2, startTime: "16:45", endTime: "17:45" })];
    const html = renderToStaticMarkup(
      <ScheduleComparison before={day1} after={moved} beforeTitle="반영 전" afterTitle="반영 후" emptyText="바뀐 일정이 없습니다." />,
    );
    expect(html.match(/data-status="changed"/g)).toHaveLength(2);
    expect(html.match(/data-status="same"/g)).toHaveLength(4);
  });

  it("같으면 그렇게 적고 강조하지 않는다", () => {
    const html = renderToStaticMarkup(
      <ScheduleComparison before={before} after={before} beforeTitle="반영 전" afterTitle="반영 후" emptyText="바뀐 일정이 없습니다." />,
    );
    expect(html).toContain("바뀐 일정이 없습니다.");
    expect(html).not.toMatch(/data-status="(added|removed|changed)"/);
  });
});

const comparison = {
  patchApplicationId: 44,
  before: { auditRunId: 812, executedAt: "2026-09-25T19:25:00+09:00" },
  after: { auditRunId: 815, executedAt: "2026-09-25T19:41:00+09:00" },
  metrics: [{ key: "blocker", label: "차단", before: 1, after: 0 }],
  warningBanner: null,
  evidence: {
    fetchedAt: "2026-09-25T19:41:00+09:00", targetContentCount: 3, dataFingerprint: "ab12cd34",
    dataFingerprintFull: null, rulesetVersion: "1.2.7", ktoModifiedAt: null, delayNotice: "", source: "출처: ⓒ한국관광공사",
  },
  revertible: true,
  schedule: { before, after },
} as ComparisonResult;

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("🔴 전후 비교 화면이 반영 기록의 바뀐 일정을 보인다", async () => {
  vi.spyOn(comparisonApi, "get").mockResolvedValue(comparison);
  await act(async () => root.render(<ComparisonView productId={31} />));
  const section = host.querySelector('section[aria-label="바뀐 일정"]');
  expect(section).not.toBeNull();
  expect(section!.querySelectorAll('[data-status="added"]')).toHaveLength(1);
  expect(section!.textContent).toContain("강릉 오죽헌");
});
