import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RuleList } from "./rules-panel";
import type { RuleView } from "../../lib/api";

const rule = (over: Partial<RuleView>): RuleView => ({
  code: "R01", name: "휴무일 · 운영시간 충돌", version: "1.2.0", defaultSeverity: "BLOCKER", requiresExternal: false, basis: "KTO_ONLY",
  dataSources: ["KTO"], threshold: "관광정보의 휴무일 · 운영시간", example: "경포대 — 10/26(월) 매주 월요일 휴무", companyAdjustable: false, ...over,
});
const rules = [
  rule({}),
  rule({ code: "R06", name: "데이터 변경 감지", defaultSeverity: null }),
  rule({ code: "R07", name: "식사 · 휴식 누락", defaultSeverity: "WARNING", dataSources: ["ITINERARY"], companyAdjustable: true }),
  rule({ code: "R08", name: "이동시간 부족", defaultSeverity: "ERROR", dataSources: ["KTO", "KAKAO"] }),
];
const lines = (): string[] => {
  const html = renderToStaticMarkup(<RuleList rules={rules} open={null} onToggle={() => undefined} />);
  return [...html.matchAll(/<button[^>]*data-rule-line[^>]*>([\s\S]*?)<\/button>/g)].map((m) => (m[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
};

describe("규칙 줄 — 이름 · 코드(작게) · 등급 · 쓰는 데이터 (UI-S8-004 · FR-OP-025)", () => {
  it("🔴 펼치지 않아도 한 줄에 등급과 쓰는 데이터가 있다", () => {
    const [r01, r06, r07, r08] = lines();
    expect(r01).toBe("쉬는 날 · 운영시간 R01 차단 관광정보 설명");
    expect(r06).toBe("정보 바뀜 R06 차단 또는 확인 불가 관광정보 설명");
    expect(r07).toBe("식사 · 휴식 R07 주의 일정 회사 기준으로 조정 가능 설명");
    expect(r08).toBe("이동 시간 R08 오류 관광정보 + 이동 시간 설명");
  });

  it("쓰는 데이터를 서비스 이름 · 코드로 적지 않는다", () => {
    const html = renderToStaticMarkup(<RuleList rules={rules} open="R08" onToggle={() => undefined} />);
    expect(html).not.toContain("KAKAO");
    expect(html).not.toContain("카카오");
    expect(html).toContain("무엇을 보나");
  });
});
