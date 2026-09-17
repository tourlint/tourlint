import { describe, expect, it } from "vitest";
import { RULE_NAMES, ruleName } from "./rule-names";

describe("규칙 이름 (UI-S3-013)", () => {
  it("R01~R10 열 개가 모두 있고 빈 이름이 없다", () => {
    for (let i = 1; i <= 10; i += 1) {
      const code = `R${String(i).padStart(2, "0")}`;
      expect(RULE_NAMES[code]).toBeDefined();
      expect(RULE_NAMES[code]).not.toBe("");
    }
    expect(Object.keys(RULE_NAMES)).toHaveLength(10);
  });

  it("이름에 규칙 번호(R01…)를 담지 않는다 — 번호는 근거 칸의 몫이다", () => {
    for (const name of Object.values(RULE_NAMES)) expect(name).not.toMatch(/R\d\d/);
  });

  it("모르는 코드는 코드를 그대로 돌려준다", () => {
    expect(ruleName("R99")).toBe("R99");
    expect(ruleName("R07")).toBe("식사 · 휴식");
  });
});
