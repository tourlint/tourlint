import { describe, expect, it } from "vitest";
import { lastCheckedText, nextCheckText, zeroMeaning } from "./radar-time";

/**
 * 「0 건」이 확인해 봤더니 없는 것인지, 아직 안 본 것인지 화면이 구분해 말해야 한다 —
 * 배치가 8월 29일까지만 처리했는데 0 건이라고만 적혀 「문제 없음」으로 읽혔다 (#644).
 */
describe("0 건의 뜻", () => {
  it("🔴 처리한 날짜가 밀려 있으면 아직 확인 전이다", () => {
    expect(zeroMeaning("2026-08-29", "2026-09-20")).toBe("아직 확인 전이에요");
    expect(zeroMeaning(null, "2026-09-20")).toBe("아직 확인 전이에요");
  });

  it("어제까지 봤으면 확인할 것이 없는 것이다", () => {
    expect(zeroMeaning("2026-09-19", "2026-09-20")).toBe("확인할 것이 없어요");
    expect(zeroMeaning("2026-09-20", "2026-09-20")).toBe("확인할 것이 없어요");
  });
});

describe("확인 시각 문구", () => {
  it("응답의 한국시간 문자열을 그대로 읽는다", () => {
    expect(lastCheckedText("2026-09-20T05:00:00+09:00", "2026-09-20")).toBe("오늘 오전 5시에 확인했어요");
    expect(lastCheckedText(null, "2026-09-20")).toBe("아직 확인하기 전이에요");
  });

  it("배치가 꺼져 있으면 그 사실을 알린다", () => {
    expect(nextCheckText(null, "2026-09-20")).toBe("지금은 자동 확인이 꺼져 있어요");
  });
});
