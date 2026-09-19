import { describe, expect, it } from "vitest";
import { stageOf } from "./stage-of";

const run = (blocker: number) => ({ counts: { blocker } });

describe("stageOf — 상품 단계 4분류 (UI-S1-010)", () => {
  it("plannedAt 이 없으면 기획 중이다 (검수 실행이 있어도)", () => {
    expect(stageOf({ plannedAt: null, releasedAt: null, latestAudit: null })).toBe("PLANNING");
    expect(stageOf({ plannedAt: null, releasedAt: null, latestAudit: run(0) })).toBe("PLANNING");
  });

  it("검수를 시작했지만 실행이 없으면 검수 중이다", () => {
    expect(stageOf({ plannedAt: "2026-10-01T00:00:00Z", releasedAt: null, latestAudit: null })).toBe("REVIEW");
  });

  it("차단이 남아 있으면 검수 중이다", () => {
    expect(stageOf({ plannedAt: "2026-10-01T00:00:00Z", releasedAt: null, latestAudit: run(2) })).toBe("REVIEW");
  });

  it("검수를 시작했고 차단이 0 이면 출시할 수 있음이다", () => {
    expect(stageOf({ plannedAt: "2026-10-01T00:00:00Z", releasedAt: null, latestAudit: run(0) })).toBe("RELEASABLE");
  });

  it("차단이 0 이어도 서버가 출시할 수 없다고 하면 검수 중이다 — 수정안 반영 뒤 재검수 전 (#551)", () => {
    expect(stageOf({
      plannedAt: "2026-10-01T00:00:00Z", releasedAt: null, latestAudit: { counts: { blocker: 0 }, releasable: false },
    })).toBe("REVIEW");
  });

  it("releasedAt 이 있으면 출시함이다", () => {
    expect(stageOf({ plannedAt: "2026-10-01T00:00:00Z", releasedAt: "2026-10-05T00:00:00Z", latestAudit: run(0) })).toBe("RELEASED");
  });
});
