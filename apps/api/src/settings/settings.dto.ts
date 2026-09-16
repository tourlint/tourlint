import { COMPANY_SETTING_LIMITS } from '@tourlint/shared';
import type { CompanyPatch, WatchRegion } from './settings.repository';

/**
 * 검수 기준 저장 입력 검증 (PUT /settings). 바꿀 수 있는 것은 회사 기준 R07 두 값과 관심
 * 키워드 · 관심 지역뿐이다 (FR-OP-022). 회사 기준은 **표준보다 엄격하게만** — 연속 일정은
 * 표준(6시간) 이하, 식사는 표준(60분) 이상이라야 한다. 느슨하면 `notStricter` 로 표시하고
 * 서비스가 400 `SETTING_NOT_STRICTER` 를 던진다 (DR-CF-008). 그 밖의 형식 오류는 `errors`.
 */

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_KEYWORDS = 50;
const MAX_REGIONS = 50;

export interface CompanyUpdateResult {
  errors: string[];
  /** 회사 기준이 표준보다 느슨함 — 400 `SETTING_NOT_STRICTER` */
  notStricter: boolean;
  patch: CompanyPatch;
}

export function validateCompanyUpdate(body: Record<string, unknown> | undefined): CompanyUpdateResult {
  const errors: string[] = [];
  const b = body ?? {};
  let notStricter = false;
  const patch: CompanyPatch = {};

  if (b.r07SpanHours !== undefined) {
    const v = b.r07SpanHours;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      errors.push('연속 일정 기준 시간은 1 이상 정수여야 합니다.');
    } else if (v > COMPANY_SETTING_LIMITS.r07SpanHoursMax) {
      notStricter = true;
    } else {
      patch.r07SpanHours = v;
    }
  }

  if (b.r07MealMinutes !== undefined) {
    const v = b.r07MealMinutes;
    if (typeof v !== 'number' || !Number.isInteger(v) || v > 240) {
      errors.push('최소 식사 시간은 240 이하 정수여야 합니다.');
    } else if (v < COMPANY_SETTING_LIMITS.r07MealMinutesMin) {
      notStricter = true;
    } else {
      patch.r07MealMinutes = v;
    }
  }

  if (b.watchKeywords !== undefined) {
    const kw = keywords(b.watchKeywords, errors);
    if (kw !== undefined) patch.watchKeywords = kw;
  }

  if (b.watchRegions !== undefined) {
    const rg = regions(b.watchRegions, errors);
    if (rg !== undefined) patch.watchRegions = rg;
  }

  return { errors, notStricter, patch };
}

function keywords(v: unknown, errors: string[]): string[] | undefined {
  if (!Array.isArray(v)) {
    errors.push('관심 키워드는 문자열 목록이어야 합니다.');
    return undefined;
  }
  const cleaned = [...new Set(v.map((k) => (typeof k === 'string' ? k.trim() : '')).filter((k) => k !== ''))];
  if (cleaned.length > MAX_KEYWORDS) {
    errors.push(`관심 키워드는 최대 ${MAX_KEYWORDS}개까지 등록할 수 있습니다.`);
    return undefined;
  }
  return cleaned;
}

/**
 * 관심 지역 검증. `{ regnCd, signguCd|null, month:"YYYY-MM" }` 모양만 받는다. 세종처럼 시군구
 * 단계가 없는 곳은 `signguCd` 가 null 이다 (개발 분담 계획 3-3).
 */
function regions(v: unknown, errors: string[]): WatchRegion[] | undefined {
  if (!Array.isArray(v)) {
    errors.push('관심 지역은 목록이어야 합니다.');
    return undefined;
  }
  if (v.length > MAX_REGIONS) {
    errors.push(`관심 지역은 최대 ${MAX_REGIONS}개까지 등록할 수 있습니다.`);
    return undefined;
  }
  const out: WatchRegion[] = [];
  for (const item of v) {
    if (typeof item !== 'object' || item === null) {
      errors.push('관심 지역 항목의 형식이 올바르지 않습니다.');
      return undefined;
    }
    const r = item as Record<string, unknown>;
    const signguCd = r.signguCd ?? null;
    if (typeof r.regnCd !== 'string' || r.regnCd.trim() === '') {
      errors.push('관심 지역의 시도 코드가 필요합니다.');
      return undefined;
    }
    if (signguCd !== null && typeof signguCd !== 'string') {
      errors.push('관심 지역의 시군구 코드 형식이 올바르지 않습니다.');
      return undefined;
    }
    if (typeof r.month !== 'string' || !MONTH_RE.test(r.month)) {
      errors.push('관심 지역의 월은 YYYY-MM 형식이어야 합니다.');
      return undefined;
    }
    out.push({ regnCd: r.regnCd, signguCd: signguCd as string | null, month: r.month });
  }
  return out;
}
