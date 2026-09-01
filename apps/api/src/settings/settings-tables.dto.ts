import { INDOOR_OUTDOOR, type IndoorOutdoor } from '@tourlint/shared';
import { KNOWN_DWELL_LCLS, KNOWN_IO_LCLS } from './settings-tables.repository';

/**
 * 표 편집 입력 검증. 범위·값 목록은 스키마 CHECK 와 맞춘다(dwell 1~1440분,
 * space_type INDOOR/OUTDOOR/MIXED). 모르는 중분류는 거부한다 — 시드에 없는 코드에
 * 값을 넣으면 판정이 그 행을 못 읽는다.
 */

interface DwellRow {
  lcls2?: unknown;
  minutes?: unknown;
}
interface IoRow {
  lcls2?: unknown;
  spaceType?: unknown;
}

export function validateDwell(body: { entries?: unknown } | undefined): {
  errors: string[];
  entries?: { lcls2: string; minutes: number }[];
} {
  const errors: string[] = [];
  const raw = body?.entries;
  if (!Array.isArray(raw)) {
    return { errors: ['entries 는 {lcls2, minutes} 목록이어야 합니다.'] };
  }
  const out: { lcls2: string; minutes: number }[] = [];
  for (const r of raw as DwellRow[]) {
    const lcls2 = typeof r.lcls2 === 'string' ? r.lcls2 : '';
    if (!KNOWN_DWELL_LCLS.has(lcls2)) {
      errors.push(`알 수 없는 중분류입니다: ${lcls2 || '(빈 값)'}`);
      continue;
    }
    if (typeof r.minutes !== 'number' || !Number.isInteger(r.minutes) || r.minutes < 1 || r.minutes > 1440) {
      errors.push(`체류시간(${lcls2})은 1~1440분 정수여야 합니다.`);
      continue;
    }
    out.push({ lcls2, minutes: r.minutes });
  }
  if (errors.length > 0) return { errors };
  return { errors, entries: out };
}

export function validateIo(body: { entries?: unknown } | undefined): {
  errors: string[];
  entries?: { lcls2: string; spaceType: IndoorOutdoor }[];
} {
  const errors: string[] = [];
  const raw = body?.entries;
  if (!Array.isArray(raw)) {
    return { errors: ['entries 는 {lcls2, spaceType} 목록이어야 합니다.'] };
  }
  const allowed = new Set<string>(INDOOR_OUTDOOR);
  const out: { lcls2: string; spaceType: IndoorOutdoor }[] = [];
  for (const r of raw as IoRow[]) {
    const lcls2 = typeof r.lcls2 === 'string' ? r.lcls2 : '';
    if (!KNOWN_IO_LCLS.has(lcls2)) {
      errors.push(`알 수 없는 중분류입니다: ${lcls2 || '(빈 값)'}`);
      continue;
    }
    const st = typeof r.spaceType === 'string' ? r.spaceType : '';
    if (!allowed.has(st)) {
      errors.push(`실내 · 야외 값(${lcls2})은 ${INDOOR_OUTDOOR.join(' · ')} 중 하나여야 합니다.`);
      continue;
    }
    out.push({ lcls2, spaceType: st as IndoorOutdoor });
  }
  if (errors.length > 0) return { errors };
  return { errors, entries: out };
}
