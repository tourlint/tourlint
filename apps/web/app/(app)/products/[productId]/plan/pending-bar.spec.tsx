// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentApi, type ProductItem } from "../../../../lib/api";
import { PendingBar, usePlaceFinder } from "./pending-bar";

const items: ProductItem[] = [{ itemId: 5, seq: 1, start: "09:00", end: "10:00", place: "경포해변", itemType: "SIGHT", ktoContentId: null, matchStatus: "PENDING", mapx: null, mapy: null }];
function Harness() {
  const finder = usePlaceFinder(70);
  return <PendingBar pendingCount={1} finder={finder} items={items} onResolved={async () => {}} />;
}

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const find = async () => {
  await act(async () => root.render(<Harness />));
  const b = [...host.querySelectorAll("button")].find((x) => x.textContent === "AI로 한 번에 찾기")!;
  await act(async () => b.click());
};

describe("AI로 한 번에 찾기가 거절됐을 때 (FR-AG-005 · EX-AG-001 · 004)", () => {
  it("🔴 예산으로 막히면 「지금은 AI로 정리할 수 없어요」 와 서버가 준 까닭을 적는다 — 「찾지 못했어요」 가 아니다", async () => {
    vi.spyOn(agentApi, "placeSuggestions").mockRejectedValue({
      status: 429, reasonCode: "BUDGET_EXHAUSTED",
      message: "오늘 쓸 수 있는 관광정보 조회를 모두 썼습니다. 내일 0시부터 다시 볼 수 있고, 일정 입력과 저장은 지금도 할 수 있습니다.",
    });
    await find();
    expect(host.textContent).toContain("지금은 AI로 정리할 수 없어요");
    expect(host.textContent).toContain("내일 0시부터 다시 볼 수 있고");
    expect(host.textContent).not.toContain("찾지 못했어요");
  });

  it("🔴 응답이 끊겨도 카드 자리에 까닭을 남긴다", async () => {
    vi.spyOn(agentApi, "placeSuggestions").mockRejectedValue(new TypeError("Failed to fetch"));
    await find();
    expect(host.textContent).toContain("지금은 AI로 정리할 수 없어요");
    expect(host.textContent).toContain("잠시 후 다시 눌러 주세요.");
  });

  it("같은 계정에서 이미 돌고 있으면 서버 말만 보인다", async () => {
    vi.spyOn(agentApi, "placeSuggestions").mockRejectedValue({ status: 429, reasonCode: "RATE_LIMIT_EXCEEDED", message: "이미 정리하고 있어요. 끝나면 다시 눌러 주세요." });
    await find();
    expect(host.textContent).toContain("이미 정리하고 있어요. 끝나면 다시 눌러 주세요.");
    expect(host.textContent).not.toContain("지금은 AI로 정리할 수 없어요");
  });
});
