import { describe, expect, it } from "vitest";
import { contactText, readNormalized, readVerdict } from "./evidence";

/**
 * 화면은 DOM 러너 없이 굴린다. 그래서 문구 조합을 순수 모듈로 빼 두고 여기서 본다 —
 * 렌더링은 동결 전 브라우저 확인이 덮는다.
 */

describe("문의처 (FR-AU-082 · EX-PS-010)", () => {
  it("없으면 정보 없음이다 — 항목을 숨기지 않는다", () => {
    expect(contactText(null)).toBe("정보 없음");
    expect(contactText(undefined)).toBe("정보 없음");
    expect(contactText("   ")).toBe("정보 없음");
  });

  it("있으면 그대로 쓴다", () => {
    expect(contactText("033-640-5130")).toBe("033-640-5130");
  });
});

describe("AI 해석 읽기 (FR-AU-013 · 061)", () => {
  it("휴무 요일을 한글로 옮긴다", () => {
    const rows = readNormalized({ weeklyClosed: ["MON", "TUE"], confidence: { overall: "CONFIRMED" } });
    expect(rows).toContainEqual({ label: "매주 휴무", value: "월요일 · 화요일" });
    expect(rows).toContainEqual({ label: "신뢰도", value: "확정" });
  });

  it("운영시간과 입장 마감을 갈라 적는다 (FR-AU-014)", () => {
    const rows = readNormalized({ openHours: { open: "09:00", close: "18:00", admissionCutoff: "17:00" } });
    expect(rows).toContainEqual({ label: "운영시간", value: "09:00~18:00" });
    expect(rows).toContainEqual({ label: "입장 마감", value: "17:00" });
  });

  it("🔴 없는 항목은 만들지 않는다 — 비어 있는 것이 모른다는 뜻이다 (FR-RU-051)", () => {
    expect(readNormalized(null)).toEqual([]);
    expect(readNormalized({})).toEqual([]);
    // 휴무 정보가 없는데 "연중무휴" 같은 줄이 생기면 안 된다
    expect(readNormalized({ openHours: { open: "09:00", close: "18:00" } }).map((r) => r.label))
      .toEqual(["운영시간"]);
  });

  it("해석하지 못한 조각은 건수로만 말한다", () => {
    const rows = readNormalized({ unparsed: [{ fragment: "점포별 상이" }, { fragment: "문의" }] });
    expect(rows).toContainEqual({ label: "해석하지 못한 조각", value: "2건" });
  });

  it("신뢰도는 문자열로 와도 읽는다", () => {
    expect(readNormalized({ confidence: "UNPARSED" })).toContainEqual({ label: "신뢰도", value: "확인 불가" });
  });
});

describe("판정 입력값 읽기", () => {
  it("규칙이 담은 것을 그대로 펼친다 — 의미를 지어내지 않는다", () => {
    expect(readVerdict({ verdict: "CLOSED", dayOfWeek: "TUE" })).toEqual([
      { label: "verdict", value: "CLOSED" },
      { label: "dayOfWeek", value: "TUE" },
    ]);
  });

  it("빈 값은 줄을 만들지 않는다", () => {
    expect(readVerdict({ a: null, b: "", c: undefined })).toEqual([]);
    expect(readVerdict(null)).toEqual([]);
  });
});
