import { describe, expect, it } from "vitest";
import { lastCheckedText, nextCheckText } from "./radar-time";

describe("lastCheckedText — 마지막 확인 (UI-S7-010)", () => {
  const today = "2026-09-15";

  it("오늘 확인했으면 오늘로 · 시각을 오전/오후로 적는다", () => {
    expect(lastCheckedText("2026-09-15T05:00:00+09:00", today)).toBe("오늘 오전 5시에 확인했어요");
  });

  it("어제면 어제로 적는다", () => {
    expect(lastCheckedText("2026-09-14T14:00:00+09:00", today)).toBe("어제 오후 2시에 확인했어요");
  });

  it("그 밖의 날은 월 일로 적는다 (주말 건너뛴 지난 금요일)", () => {
    // 2026-09-15 는 화요일 — 지난 금요일은 09-11
    expect(lastCheckedText("2026-09-11T05:00:00+09:00", today)).toBe("9월 11일 오전 5시에 확인했어요");
  });

  it("확인 전이면 그 사실을 알린다", () => {
    expect(lastCheckedText(null, today)).toBe("아직 확인하기 전이에요");
  });
});

describe("nextCheckText — 다음 확인", () => {
  const friday = "2026-09-18"; // 금요일

  it("주말을 건너뛴 다음 평일(월요일)을 짚는다", () => {
    // 배치가 토·일을 건너뛰어 다음 확인이 09-21(월)이다
    expect(nextCheckText("2026-09-21T05:00:00+09:00", friday)).toBe("다음 확인은 월요일 아침이에요");
  });

  it("내일이면 내일로 적는다", () => {
    expect(nextCheckText("2026-09-19T05:00:00+09:00", "2026-09-18")).toBe("다음 확인은 내일 아침이에요");
  });

  it("배치가 꺼져 있으면 그 사실을 알린다", () => {
    expect(nextCheckText(null, friday)).toBe("지금은 자동 확인이 꺼져 있어요");
  });
});
