import { describe, expect, it } from "vitest";
import { scoreSentence } from "./score-sentence";

const W = { BLOCKER: 25, ERROR: 10, WARNING: 4, UNVERIFIED: 3 };

describe("scoreSentence — 점수 계산 문장 (UI-S3-010)", () => {
  it("감점이 있는 등급만 적는다 (0건 등급 생략)", () => {
    const s = scoreSentence({ blocker: 0, error: 0, warning: 2, unverified: 1 }, W);
    expect(s).toBe("100점에서 주의 2건 −8점, 확인 불가 1건 −3점");
  });

  it("모두 0 이면 감점 없이 만점이라고 적는다", () => {
    expect(scoreSentence({ blocker: 0, error: 0, warning: 0, unverified: 0 }, W)).toBe("감점 없이 100점");
  });

  it("무시 건수는 문장에 넣지 않는다 — 무시 제외는 별도 문구다", () => {
    // dismissed 는 GradeCounts 에 없다. 주의만 남는다.
    const s = scoreSentence({ blocker: 0, error: 0, warning: 1, unverified: 0 }, W);
    expect(s).toBe("100점에서 주의 1건 −4점");
  });
});
