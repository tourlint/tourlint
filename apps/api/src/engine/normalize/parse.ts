import type { ContentTypeId } from '@tourlint/shared';
import { parseClosedRaw } from './closed';
import { parseHoursRaw } from './hours';
import { mergeNormalized } from './merge';
import { splitNotes, stripFormatting } from './preprocess';
import { parseTimeOfDay } from './primitives';
import { emptyNormalized, type NormalizedOperatingInfo, type UnparsedFragment } from './types';

/**
 * 운영정보 해석기 진입점 — 공사 소개정보 원문 → `normalized_json` (FR-AU-003 ~ 016 · DR-NM).
 *
 * 사전 파서(정규식)가 처리한 조각에는 LLM 을 부르지 않는다 (FR-AU-003). 실측 정답셋
 * 287건 기준 휴무 96% · 운영 95% 를 정규식만으로 덮으므로 LLM 은 나머지 꼬리에만 쓴다.
 *
 * **해석 실패를 정상으로 판정하지 않는다** (FR-AU-009). 못 읽은 조각은 `unparsed` 에
 * 사유와 함께 남고, 그 축이 통째로 비면 `affects` 를 통해 신뢰도가 `UNPARSED` 로 내려간다.
 */

/** 유형별 운영정보 필드 (EI-KT 3-3 실측 확정) */
interface FieldMap {
  readonly rest: string | null;
  readonly hours: string | null;
  readonly checkIn?: string;
  readonly checkOut?: string;
}

const OPERATING_FIELDS: Readonly<Record<ContentTypeId, FieldMap>> = {
  12: { rest: 'restdate', hours: 'usetime' },
  14: { rest: 'restdateculture', hours: 'usetimeculture' },
  // 행사(15)는 휴무 대신 행사 기간이 판정 근거다. 여기서는 공연 시각만 읽는다
  15: { rest: null, hours: 'playtime' },
  28: { rest: 'restdateleports', hours: 'usetimeleports' },
  // DR-NM-024 — 숙박은 1·3단계를 수행하지 않고 입실·퇴실만 읽는다
  32: { rest: null, hours: null, checkIn: 'checkintime', checkOut: 'checkouttime' },
  38: { rest: 'restdateshopping', hours: 'opentime' },
  39: { rest: 'restdatefood', hours: 'opentimefood' },
};

/** 휴무 축이 통째로 비었을 때 확인 불가로 내려갈 경로 — R01 이 읽는 필드들이다 */
const CLOSED_PATHS = ['alwaysOpen', 'weeklyClosed', 'nthWeekday', 'fixedClosed', 'holidayRule'] as const;
/** 운영시간 축이 통째로 비었을 때 내려갈 경로 */
const HOURS_PATHS = ['openHours', 'dayOfWeekHours', 'seasonalHours'] as const;

export interface ParseOperatingInfoInput {
  readonly contentTypeId: ContentTypeId;
  /** `detailIntro2` 응답 항목 */
  readonly raw: Readonly<Record<string, unknown>>;
}

export function parseOperatingInfo(input: ParseOperatingInfoInput): NormalizedOperatingInfo {
  const fields = OPERATING_FIELDS[input.contentTypeId];

  if (fields.checkIn !== undefined && fields.checkOut !== undefined) {
    return parseLodging(input.raw, fields.checkIn, fields.checkOut);
  }

  const sourceFieldNames = [fields.rest, fields.hours].filter((f): f is string => f !== null);
  const unparsed: UnparsedFragment[] = [];

  const restRaw = readField(input.raw, fields.rest);
  const closed = restRaw === '' ? null : parseClosedRaw(restRaw);
  const closedHits = closed?.hits ?? [];

  if (fields.rest !== null) {
    if (restRaw === '') {
      // 결측은 해석 실패가 아니라 정상 산출물이다. 그래도 판정에는 쓸 수 없다 (EX-PS · FR-AU-009)
      unparsed.push({ fragment: '', reason: 'MISSING', affects: [...CLOSED_PATHS] });
    } else {
      pushFragments(unparsed, closed?.unparsedFragments ?? [], CLOSED_PATHS, closedHits.length > 0);
    }
  }

  const hoursRaw = readField(input.raw, fields.hours);
  const hours = hoursRaw === '' ? null : parseHoursRaw(hoursRaw);
  const hoursGroups = hours?.groups ?? [];
  const hasUsableHours = hoursGroups.some((g) => g.allDay || g.items.some((i) => i.role === 'OPEN' || i.role === 'CHECK_IN'));

  if (fields.hours !== null) {
    if (hoursRaw === '') {
      unparsed.push({ fragment: '', reason: 'MISSING', affects: [...HOURS_PATHS] });
    } else {
      pushFragments(unparsed, hours?.unparsedFragments ?? [], HOURS_PATHS, hasUsableHours);
    }
  }

  return mergeNormalized({ sourceFieldNames, closedHits, hoursGroups, unparsed });
}

/**
 * 숙박(32) — 휴무 판정과 시각 판정을 하지 않는다 (DR-NM-024 · FR-AU-011).
 *
 * `sourceFieldNames` 는 `["checkintime", "checkouttime"]` 로 고정한다. 지문 필드와 같은
 * 목록이어야 변경 감지와 해석 근거가 어긋나지 않는다.
 */
function parseLodging(
  raw: Readonly<Record<string, unknown>>,
  checkInField: string,
  checkOutField: string,
): NormalizedOperatingInfo {
  const base = emptyNormalized([checkInField, checkOutField]);
  const unparsed: UnparsedFragment[] = [];

  const checkIn = readTimeField(raw, checkInField, unparsed, 'checkIn');
  const checkOut = readTimeField(raw, checkOutField, unparsed, 'checkOut');

  const byPath: Record<string, 'CONFIRMED' | 'ESTIMATED' | 'UNPARSED'> = {};
  if (checkIn !== null) byPath.checkIn = 'CONFIRMED';
  if (checkOut !== null) byPath.checkOut = 'CONFIRMED';
  for (const u of unparsed) for (const path of u.affects) byPath[path] = 'UNPARSED';

  return {
    ...base,
    checkIn,
    checkOut,
    confidence: {
      overall: Object.values(byPath).includes('UNPARSED') ? 'UNPARSED' : checkIn === null && checkOut === null ? 'UNPARSED' : 'CONFIRMED',
      byPath,
    },
    unparsed,
  };
}

function readTimeField(
  raw: Readonly<Record<string, unknown>>,
  field: string,
  unparsed: UnparsedFragment[],
  path: string,
): string | null {
  const { main } = splitNotes(readField(raw, field));
  if (main === '') {
    unparsed.push({ fragment: '', reason: 'MISSING', affects: [path] });
    return null;
  }
  // `15:00` · `오후 3시` · `- 입실 15:00` 어느 쪽이든 시각 하나만 뽑는다
  const m = /(\d{1,2}\s*(?::\s*\d{2}|시(?:\s*\d{1,2}\s*분)?))/.exec(main);
  const time = m === null ? null : parseTimeOfDay(m[1] as string);
  if (time === null) unparsed.push({ fragment: main, reason: 'SCHEMA_INVALID', affects: [path] });
  return time;
}

/**
 * 못 읽은 조각이 **그 축을 무효로 만드는지**를 사유별로 가른다.
 *
 * | 사유 | 값을 이미 읽었을 때 | 왜 |
 * |---|---|---|
 * | `TARGET_VARIES` | **무효로 만든다** | `06:00~23:00 ※ 점포별 상이함` — 읽은 시각이 어느 점포 것인지 알 수 없다 |
 * | `MISSING` | 무효로 만든다 | 축 자체가 비었다 |
 * | `REFERENCE` | 보조로 둔다 | `09:00~18:00 ※ 자세한 사항은 전화문의` — 시각은 그대로 유효하다 |
 * | `CONDITIONAL` | 보조로 둔다 | 못 읽은 조건이 있을 뿐 읽은 값이 틀린 건 아니다 |
 *
 * 값을 하나도 못 읽었으면 사유와 무관하게 축 전체를 무효로 만든다 (FR-AU-009).
 */
const ALWAYS_INVALIDATING = new Set(['TARGET_VARIES', 'MISSING']);

function pushFragments(
  target: UnparsedFragment[],
  fragments: readonly { readonly fragment: string; readonly reason: UnparsedFragment['reason'] }[],
  axisPaths: readonly string[],
  axisHasValue: boolean,
): void {
  for (const f of fragments) {
    const invalidates = !axisHasValue || ALWAYS_INVALIDATING.has(f.reason);
    target.push({ fragment: f.fragment, reason: f.reason, affects: invalidates ? [...axisPaths] : [] });
  }
}

function readField(raw: Readonly<Record<string, unknown>>, field: string | null): string {
  if (field === null) return '';
  const value = raw[field];
  return typeof value === 'string' ? stripFormatting(value) : '';
}
