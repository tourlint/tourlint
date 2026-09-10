/**
 * 판단 근거 3단 병기의 **문구 조합** (FR-AU-013 · 061).
 *
 * 순수 함수만 둔다 — `apps/web` 에는 DOM 테스트 러너가 없어서, 조합 규칙을 여기 모아
 * 두어야 검증할 수 있는 자리가 생긴다.
 *
 * 공사 원문은 손대지 않는다. 여기서 다루는 것은 **우리 산출물(AI 해석)** 을 읽을 수 있게
 * 옮기는 일뿐이다.
 */

export interface EvidenceRow {
  readonly label: string;
  readonly value: string;
}

const WEEKDAY: Record<string, string> = {
  MON: "월", TUE: "화", WED: "수", THU: "목", FRI: "금", SAT: "토", SUN: "일",
};

const CONFIDENCE: Record<string, string> = {
  CONFIRMED: "확정", ESTIMATED: "추정", UNPARSED: "확인 불가",
};

/** 문의처가 없으면 "정보 없음". 항목을 숨기지 않는다 (FR-AU-082 · EX-PS-010) */
export function contactText(tel: string | null | undefined): string {
  const v = (tel ?? "").trim();
  return v === "" ? "정보 없음" : v;
}

/**
 * AI 해석을 읽을 수 있는 줄로 옮긴다. **없는 항목은 만들지 않는다** — 비어 있으면
 * 그 줄이 아예 없는 것이 "모른다"를 말하는 방법이다 (FR-RU-051).
 */
export function readNormalized(ai: Record<string, unknown> | null | undefined): EvidenceRow[] {
  if (ai === null || ai === undefined) return [];
  const rows: EvidenceRow[] = [];

  if (ai.alwaysOpen === true) rows.push({ label: "휴무", value: "연중무휴" });

  const weekly = asStrings(ai.weeklyClosed);
  if (weekly.length > 0) {
    rows.push({ label: "매주 휴무", value: weekly.map((d) => `${WEEKDAY[d] ?? d}요일`).join(" · ") });
  }

  const hours = ai.openHours;
  if (isRecord(hours)) {
    const open = asText(hours.open);
    const close = asText(hours.close);
    if (open !== "" && close !== "") rows.push({ label: "운영시간", value: `${open}~${close}` });
    const cutoff = asText(hours.admissionCutoff);
    if (cutoff !== "") rows.push({ label: "입장 마감", value: cutoff });
  }

  const perDay = Array.isArray(ai.dayOfWeekHours) ? ai.dayOfWeekHours.length : 0;
  if (perDay > 0) rows.push({ label: "요일별 운영시간", value: `${perDay}건` });

  const checkIn = asText(ai.checkIn);
  const checkOut = asText(ai.checkOut);
  if (checkIn !== "" || checkOut !== "") {
    rows.push({ label: "입실 · 퇴실", value: `${checkIn || "-"} / ${checkOut || "-"}` });
  }

  const unparsed = Array.isArray(ai.unparsed) ? ai.unparsed.length : 0;
  if (unparsed > 0) rows.push({ label: "해석하지 못한 조각", value: `${unparsed}건` });

  const conf = confidenceOf(ai.confidence);
  if (conf !== null) rows.push({ label: "신뢰도", value: CONFIDENCE[conf] ?? conf });

  return rows;
}

/** 판정 입력값. 규칙이 담은 것을 그대로 펼친다 — 화면이 의미를 지어내지 않는다 */
export function readVerdict(verdict: unknown): EvidenceRow[] {
  if (!isRecord(verdict)) return [];
  return Object.entries(verdict)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([label, v]) => ({ label, value: asText(v) || String(v) }));
}

function confidenceOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (isRecord(v) && typeof v.overall === "string") return v.overall;
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function asText(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}
