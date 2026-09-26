import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contactText, readNormalized, readVerdict, ruleLine } from "./evidence";

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

  it("🔴 N번째 요일 · 날짜 · 명절 휴무를 옮긴다 — 이 사유로 막힌 카드의 해석 칸이 비지 않게 (#848)", () => {
    const rows = readNormalized({
      nthWeekday: [{ nth: 2, day: "MON" }, { nth: 4, day: "MON" }],
      fixedClosed: ["01-01", "12-25"],
      holidayRule: ["LUNAR_NEW_YEAR", "CHUSEOK"],
    });
    expect(rows).toContainEqual({ label: "매월 휴무", value: "둘째 월요일 · 넷째 월요일" });
    expect(rows).toContainEqual({ label: "날짜 휴무", value: "1월 1일 · 12월 25일" });
    expect(rows).toContainEqual({ label: "명절 · 공휴일 휴무", value: "설날 · 추석" });
  });

  it("🔴 조건부 휴무 · 시설 일부 휴관을 옮긴다 (#848)", () => {
    const rows = readNormalized({
      conditionalRule: [{ kind: "HOLIDAY_NEXT_DAY", appliesTo: ["MON"] }],
      partialClosed: [{ scope: "실내 전시실", on: ["01-01", "CHUSEOK"] }],
    });
    expect(rows).toContainEqual({ label: "조건부 휴무", value: "월요일 — 공휴일이면 다음 날 휴무" });
    expect(rows).toContainEqual({ label: "일부 휴관", value: "실내 전시실 — 1월 1일 · 추석" });
  });

  it("🔴 휴게시간 · 요일별 · 기간별 운영시간을 시각으로 적는다 — 건수가 아니라 (#848)", () => {
    const rows = readNormalized({
      openHours: { open: "09:00", close: "18:00", breaks: [{ from: "12:00", to: "13:00" }], admissionCutoff: null },
      dayOfWeekHours: [{ days: ["SAT", "SUN"], open: "10:00", close: "17:00", breaks: [], admissionCutoff: null }],
      seasonalHours: [{ from: "03-01", to: "10-31", open: "09:00", close: "19:00", breaks: [], admissionCutoff: null, label: "하절기" }],
    });
    expect(rows).toContainEqual({ label: "휴게시간", value: "12:00~13:00" });
    expect(rows).toContainEqual({ label: "요일별 운영시간", value: "토 · 일 10:00~17:00" });
    expect(rows).toContainEqual({ label: "기간별 운영시간", value: "3월 1일~10월 31일 09:00~19:00" });
  });

  it("빈 목록 · 모양이 아닌 값은 줄을 만들지 않는다", () => {
    expect(readNormalized({
      nthWeekday: [], fixedClosed: [], holidayRule: [], conditionalRule: [], partialClosed: [],
      dayOfWeekHours: [], seasonalHours: [],
    })).toEqual([]);
    expect(readNormalized({ nthWeekday: [{ nth: 9, day: "MON" }], partialClosed: [{ scope: "" }] })).toEqual([]);
  });
});

describe("근거 칸 머리 (#848)", () => {
  it("🔴 규칙 번호와 그 판정의 규칙 버전을 함께 적는다 — 기능설명서 「판정마다 규칙 버전 병기」", () => {
    expect(ruleLine("R01", "1.0.5")).toBe("규칙 R01 · 버전 1.0.5");
  });

  it("🔴 결과 화면의 근거 칸이 판정의 규칙 버전을 넘겨 받는다", () => {
    // 카드 컴포넌트는 DOM 러너 없이 못 그린다 — 넘기는 자리를 소스로 본다
    const src = readFileSync(join(__dirname, "../(app)/products/[productId]/audit-result.tsx"), "utf8");
    expect(src).toContain("ruleVersion={finding.ruleVersion}");
    expect(src).toContain("ruleLine(ruleCode, ruleVersion)");
  });

  it("버전이 없으면 번호만", () => {
    expect(ruleLine("R01", "")).toBe("규칙 R01");
    expect(ruleLine("R01", null)).toBe("규칙 R01");
    expect(ruleLine("R01", undefined)).toBe("규칙 R01");
  });
});

describe("판정 입력값 읽기", () => {
  it("이름표와 값을 사람 말로 옮긴다 (#478)", () => {
    // 종전에는 `verdict: CLOSED` 처럼 규칙이 담은 그대로였다. 뜻을 더하는 것이 아니라
    // 같은 사실을 실무자 말로 적는 것이고, 어휘는 `@tourlint/shared` 에 있다.
    expect(readVerdict({ verdict: "CLOSED", dayOfWeek: "TUE" })).toEqual([
      { label: "판정", value: "휴무일" },
      { label: "요일", value: "화요일" },
    ]);
  });

  it("모르는 키는 키 이름 그대로 — 이름이 없다고 근거를 숨기지 않는다", () => {
    expect(readVerdict({ somethingNew: "값" })).toEqual([{ label: "somethingNew", value: "값" }]);
  });

  it("빈 값은 줄을 만들지 않는다", () => {
    expect(readVerdict({ a: null, b: "", c: undefined })).toEqual([]);
    expect(readVerdict(null)).toEqual([]);
  });
});
