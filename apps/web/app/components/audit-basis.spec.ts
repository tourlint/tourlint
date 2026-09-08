import { describe, expect, it } from "vitest";
import { basisRows, ktoDate } from "./audit-basis";

const evidence = {
  fetchedAt: "2026-09-15T14:32:07.000Z",
  targetContentCount: 8,
  dataFingerprint: "a3f91c2e",
  dataFingerprintFull: "a3f91c2e".repeat(8),
  rulesetVersion: "1.3.0",
  ktoModifiedAt: "20260914153000",
};

describe("검수 근거 영역 (UI-CM-031)", () => {
  it("문서가 정한 다섯 줄을 만든다", () => {
    expect(basisRows(evidence).map((r) => r.label)).toEqual([
      "조회 시각", "대상 콘텐츠", "데이터 지문", "규칙셋", "데이터 최종 수정일",
    ]);
  });

  it("대상 건수와 지문 축약을 그대로 싣는다", () => {
    const rows = basisRows(evidence);
    expect(rows[1]).toMatchObject({ value: "8곳" });
    expect(rows[2]).toMatchObject({ value: "a3f91c2e", full: evidence.dataFingerprintFull });
  });

  it("지문을 산출하지 못했으면 그렇게 적는다 — 빈칸으로 두지 않는다", () => {
    const rows = basisRows({ ...evidence, dataFingerprint: null, dataFingerprintFull: null });
    expect(rows[2]?.value).toBe("산출하지 않음");
  });
});

describe("공사 데이터 최종 수정일 (DR-PR-008)", () => {
  it("원문 YYYYMMDDHHmmss 를 날짜까지만 읽는다", () => {
    expect(ktoDate("20260914153000")).toBe("2026-09-14");
  });

  it("🔴 없거나 짧으면 지어내지 않는다", () => {
    expect(ktoDate(null)).toBe("알 수 없음");
    expect(ktoDate("2026")).toBe("알 수 없음");
  });
});
