import { describe, expect, it } from "vitest";
import { signguHint } from "./region-select";

/**
 * 시군구를 비워 두면 그 시도 전체를 조회한다. 그런데 맨 위 칸이 「선택」 이라 하나를 꼭
 * 골라야 하는 줄 알았다 — 서울 전역을 보려던 사람이 종로구만 보게 된다 (#583 · UI-S2-004).
 */
describe("시군구 드롭다운 맨 위 칸 (UI-S2-004)", () => {
  it("🔴 고를 수 있는 상태에서는 「전체」 라고 알려 준다", () => {
    expect(signguHint({ regnCode: "11", error: false, loading: false, count: 25 })).toBe("전체");
  });

  it("나머지 상태 문구는 그대로다 — 셋을 뭉뚱그리지 않는다", () => {
    expect(signguHint({ regnCode: "", error: false, loading: false, count: 0 })).toBe("시도 먼저 선택");
    expect(signguHint({ regnCode: "11", error: true, loading: false, count: 0 })).toBe("불러오기 실패");
    expect(signguHint({ regnCode: "11", error: false, loading: true, count: 0 })).toBe("불러오는 중…");
    expect(signguHint({ regnCode: "11", error: false, loading: false, count: 0 })).toBe("해당 없음");
  });
});
