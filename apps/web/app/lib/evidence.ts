import { HOLIDAY_LABEL, verdictRows } from "@tourlint/shared";

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
  CONFIRMED: "확정", ESTIMATED: "확실하지 않아요", UNPARSED: "확인 불가",
};

const ORDINAL: Record<number, string> = { 1: "첫째", 2: "둘째", 3: "셋째", 4: "넷째", 5: "다섯째" };

/**
 * 근거 칸 머리 — 규칙 번호와 **그 판정을 낸 규칙의 버전** (#848).
 *
 * 제출한 기능설명서가 「판정마다 공사 원문과 규칙 버전을 병기」라고 적었다. 요약의 규칙셋
 * 버전은 실행 전체의 값이라 판정마다의 버전을 대신하지 못한다.
 */
export function ruleLine(ruleCode: string, ruleVersion: string | null | undefined): string {
  const v = (ruleVersion ?? "").trim();
  return v === "" ? `규칙 ${ruleCode}` : `규칙 ${ruleCode} · 버전 ${v}`;
}

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

  // 종전에는 여기서부터 빠져서, 이 사유로 막힌 카드는 해석 칸에 신뢰도만 남았다 (#848)
  const nth = records(ai.nthWeekday)
    .map((r) => {
      const day = asText(r.day);
      const n = Number(r.nth);
      return day === "" || !(n in ORDINAL) ? "" : `${ORDINAL[n]} ${WEEKDAY[day] ?? day}요일`;
    })
    .filter((v) => v !== "");
  if (nth.length > 0) rows.push({ label: "매월 휴무", value: nth.join(" · ") });

  const fixed = asStrings(ai.fixedClosed).map(monthDay);
  if (fixed.length > 0) rows.push({ label: "날짜 휴무", value: fixed.join(" · ") });

  const holidays = asStrings(ai.holidayRule).map((h) => HOLIDAY_LABEL[h] ?? h);
  if (holidays.length > 0) rows.push({ label: "명절 · 공휴일 휴무", value: holidays.join(" · ") });

  const conditional = records(ai.conditionalRule).map((r) => {
    const days = asStrings(r.appliesTo).map((d) => `${WEEKDAY[d] ?? d}요일`).join(" · ");
    const what = r.kind === "HOLIDAY_NEXT_DAY" ? "공휴일이면 다음 날 휴무" : "조건이 붙은 휴무";
    return days === "" ? what : `${days} — ${what}`;
  });
  if (conditional.length > 0) rows.push({ label: "조건부 휴무", value: conditional.join(" / ") });

  const partial = records(ai.partialClosed)
    .map((r) => {
      const scope = asText(r.scope);
      const on = asStrings(r.on).map((d) => HOLIDAY_LABEL[d] ?? monthDay(d));
      if (scope === "") return "";
      return on.length === 0 ? scope : `${scope} — ${on.join(" · ")}`;
    })
    .filter((v) => v !== "");
  if (partial.length > 0) rows.push({ label: "일부 휴관", value: partial.join(" / ") });

  const hours = ai.openHours;
  if (isRecord(hours)) {
    const open = asText(hours.open);
    const close = asText(hours.close);
    if (open !== "" && close !== "") rows.push({ label: "운영시간", value: `${open}~${close}` });
    const cutoff = asText(hours.admissionCutoff);
    if (cutoff !== "") rows.push({ label: "입장 마감", value: cutoff });
    const breaks = spans(hours.breaks);
    if (breaks !== "") rows.push({ label: "휴게시간", value: breaks });
  }

  const perDay = records(ai.dayOfWeekHours)
    .map((r) => {
      const days = asStrings(r.days).map((d) => WEEKDAY[d] ?? d).join(" · ");
      const range = hoursRange(r);
      return days === "" || range === "" ? "" : `${days} ${range}`;
    })
    .filter((v) => v !== "");
  if (perDay.length > 0) rows.push({ label: "요일별 운영시간", value: perDay.join(" / ") });

  const seasonal = records(ai.seasonalHours)
    .map((r) => {
      const from = asText(r.from);
      const to = asText(r.to);
      const range = hoursRange(r);
      return from === "" || to === "" || range === "" ? "" : `${monthDay(from)}~${monthDay(to)} ${range}`;
    })
    .filter((v) => v !== "");
  if (seasonal.length > 0) rows.push({ label: "기간별 운영시간", value: seasonal.join(" / ") });

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

/**
 * 판정 입력값 (#478).
 *
 * 종전에는 규칙이 담은 것을 그대로 펼쳤다 — 키도 값도 영어였고 객체는 `[object Object]`
 * 로 나왔다. 어휘는 키를 만드는 쪽(규칙엔진) 것이라 `@tourlint/shared` 에 있다.
 */
export function readVerdict(verdict: unknown): EvidenceRow[] {
  return verdictRows(verdict);
}

function confidenceOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (isRecord(v) && typeof v.overall === "string") return v.overall;
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function records(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

/** `MM-DD` → `1월 1일`. 모양이 아니면 그대로 둔다 */
function monthDay(v: string): string {
  const m = /^(\d{2})-(\d{2})$/.exec(v);
  return m === null ? v : `${Number(m[1])}월 ${Number(m[2])}일`;
}

/** 운영시간 한 덩어리 — `09:00~18:00`, 휴게가 있으면 괄호로 붙인다 */
function hoursRange(r: Record<string, unknown>): string {
  const open = asText(r.open);
  const close = asText(r.close);
  if (open === "" || close === "") return "";
  const breaks = spans(r.breaks);
  return breaks === "" ? `${open}~${close}` : `${open}~${close} (휴게 ${breaks})`;
}

function spans(v: unknown): string {
  return records(v)
    .map((s) => {
      const from = asText(s.from);
      const to = asText(s.to);
      return from === "" || to === "" ? "" : `${from}~${to}`;
    })
    .filter((x) => x !== "")
    .join(" · ");
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function asText(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}
