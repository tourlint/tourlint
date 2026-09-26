import { describe, expect, it } from "vitest";
import { batchStatusLabel, checkedBasisText, emptyListText, lastCheckedText, nextCheckText, zeroMeaning } from "./radar-time";

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

describe("마지막 확인의 결과 (NF-OB-004 · TM-013)", () => {
  it("🔴 실패했거나 일부만 읽은 날은 처리 기준일이 어제여도 0 을 「확인할 것이 없어요」로 적지 않는다", () => {
    expect(zeroMeaning("2026-09-19", "2026-09-20", "HIDDEN_OVERFLOW")).toBe("일부만 확인했어요");
    expect(zeroMeaning("2026-09-19", "2026-09-20", "FAILED")).toBe("확인하지 못했어요");
    expect(zeroMeaning("2026-09-19", "2026-09-20", "OK")).toBe("확인할 것이 없어요");
    expect(zeroMeaning("2026-09-17", "2026-09-20", "EMPTY")).toBe("아직 확인 전이에요");
  });

  it("🔴 상태 코드를 화면에 그대로 적지 않는다", () => {
    for (const code of ["OK", "EMPTY", "FAILED", "HIDDEN_OVERFLOW", "SOMETHING_NEW"]) {
      const label = batchStatusLabel(code);
      expect(label).not.toMatch(/[A-Z_]{2,}/);
    }
    expect(batchStatusLabel("HIDDEN_OVERFLOW")).toBe("일부만 확인");
    expect(batchStatusLabel(null)).toBe("—");
  });
});

describe("빈 알림 목록의 문장 (UI-S7-010)", () => {
  it("🔴 확인해 보니 없는 것만 「없습니다」다 — 아직 · 실패 · 일부는 그렇게 적는다", () => {
    expect(emptyListText("RISK", "확인할 것이 없어요")).toBe("현재 여행에 확인할 바뀐 정보가 없습니다.");
    expect(emptyListText("OPPORTUNITY", "확인할 것이 없어요")).toBe("현재 여행에 확인할 새 소식이 없습니다.");
    for (const meaning of ["아직 확인 전이에요", "확인하지 못했어요", "일부만 확인했어요", null]) {
      expect(emptyListText("RISK", meaning)).not.toContain("없습니다");
    }
    expect(emptyListText("RISK", "일부만 확인했어요")).toContain("일부만 확인했어요");
  });
});

describe("오늘 할 일 기준 시각 (UI-S7-018)", () => {
  it("응답의 한국시간으로 「오늘 오전 5시 확인 기준」", () => {
    expect(checkedBasisText("2026-09-20T05:00:12+09:00", "2026-09-20")).toBe("오늘 오전 5시 확인 기준");
    expect(checkedBasisText("2026-09-19T05:00:12+09:00", "2026-09-20")).toBe("어제 오전 5시 확인 기준");
  });
});
