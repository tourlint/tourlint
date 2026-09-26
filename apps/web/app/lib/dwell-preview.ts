import { DWELL_MINUTES_SEED, SETTING_DEFAULTS } from "@tourlint/shared";

// 끝 시간을 기본 체류시간으로 채우는 줄의 표시 (FR-IN-011 · UI-S2-009 · 032). 엔진의
// engine/itinerary/dwell.ts 와 같은 표 · 같은 규칙이다 — 화면이 다른 값을 지어내면 실제 검수와 어긋난다.
//   · 숙박은 끝 시간을 채우지 않는다
//   · 중분류 표에 있으면 그 값, 없으면(미매핑 · 분류 없음) 90분
//   · 자정을 넘기면 24:00 에서 멈춘다
// 판정은 하지 않는다. 검수가 어떤 시각으로 보는지를 미리 보일 뿐이다.

/** 그 줄에 채울 체류시간(분). 숙박이면 null */
export function dwellMinutes(itemType: string, lcls2: string | null): number | null {
  if (itemType === "LODGING") return null;
  return (lcls2 === null ? undefined : DWELL_MINUTES_SEED[lcls2]) ?? SETTING_DEFAULTS.dwellFallbackMinutes;
}

/** 시작 + 분. 시각을 못 읽으면 null */
export function endAfter(start: string, minutes: number): string | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(start);
  if (m === null) return null;
  const total = Math.min(Number(m[1]) * 60 + Number(m[2]) + minutes, 24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export interface DwellLine {
  readonly start: string;
  /** 끝 시각. 비었으면 null */
  readonly end: string | null;
  readonly itemType: string;
  /**
   * 중분류. `undefined` 는 아직 모른다는 뜻이다 — 고르는 중이라 검수 때 분류가 정해지거나, 옛
   * 응답이라 값이 없다. 모르면 시각을 짓지 않는다
   */
  readonly lcls2: string | null | undefined;
  /** 적힌 끝 시각이 기본 체류시간으로 채운 값인가 (끝 시각 출처가 입력이 아님) */
  readonly endFromDwell: boolean;
}

export interface DwellDefault {
  readonly minutes: number;
  readonly end: string;
  /** 끝 시간이 비어 검수가 채울 시각 — 회색으로 보인다 */
  readonly preview: boolean;
}

/** 그 줄의 끝 시각이 기본 체류시간에서 오는가. 아니면(직접 적은 끝 · 숙박 · 분류 모름) null */
export function dwellDefault(line: DwellLine): DwellDefault | null {
  if (line.lcls2 === undefined) return null;
  const minutes = dwellMinutes(line.itemType, line.lcls2);
  if (minutes === null) return null;
  if (line.end === null || line.end === "") {
    const end = endAfter(line.start, minutes);
    return end === null ? null : { minutes, end, preview: true };
  }
  return line.endFromDwell ? { minutes, end: line.end, preview: false } : null;
}

/**
 * 저장된 줄의 분류 — 모르면 `undefined` 라 시각 · 배지를 짓지 않는다. 고르는 중(PENDING)이면 분류가
 * 검수 때 정해지고, 직접 정한 곳(EXCLUDED)은 검수가 판정에서 통째로 빼서(`audit-runner` · FR-IN-025)
 * 채울 시각이 어디에도 쓰이지 않는다. 걷기 길도 직접 정한 곳이다.
 */
export function knownLcls2(matchStatus: string, lcls2: string | null | undefined): string | null | undefined {
  return matchStatus === "PENDING" || matchStatus === "EXCLUDED" ? undefined : lcls2;
}

/** 상품 상세의 항목 한 줄. 고르는 중 · 직접 정한 곳은 짓지 않는다 (`knownLcls2`) */
export function dwellDefaultOf(item: {
  start: string;
  end: string | null;
  itemType: string;
  matchStatus: string;
  lcls2?: string | null;
  endTimeSource?: string;
}): DwellDefault | null {
  return dwellDefault({
    start: item.start,
    end: item.end,
    itemType: item.itemType,
    lcls2: knownLcls2(item.matchStatus, item.lcls2),
    endFromDwell: item.endTimeSource !== undefined && item.endTimeSource !== "INPUT",
  });
}
