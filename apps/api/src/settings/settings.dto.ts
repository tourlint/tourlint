import type { AccountSettings } from './settings.repository';

/**
 * 계정 설정 입력 검증. 범위는 스키마 CHECK 제약과 일치시킨다 (user_setting) — DB 가 던지기
 * 전에 화면이 읽을 수 있는 문구로 돌려주기 위해서다.
 */

const SEVERITIES = ['BLOCKER', 'ERROR', 'WARNING', 'UNVERIFIED'] as const;
const MAX_KEYWORDS = 50;

interface Raw {
  weights?: unknown;
  r07SpanHours?: unknown;
  r07MealMinutes?: unknown;
  r04Threshold?: unknown;
  watchKeywords?: unknown;
}

export function validateAccountSettings(body: Raw | undefined): { errors: string[]; settings?: AccountSettings } {
  const errors: string[] = [];
  const b = body ?? {};

  const weights = intMap(b.weights, errors);
  const r07SpanHours = intInRange(b.r07SpanHours, 1, 24, 'R07 연속 일정 기준 시간', '1~24시간', errors);
  const r07MealMinutes = intInRange(b.r07MealMinutes, 1, 240, 'R07 최소 식사 시간', '1~240분', errors);
  const r04Threshold = intInRange(b.r04Threshold, 2, 10, 'R04 편중 임계치', '2~10', errors);
  const watchKeywords = keywords(b.watchKeywords, errors);

  if (errors.length > 0) return { errors };
  return {
    errors,
    settings: {
      weights: weights!,
      r07SpanHours: r07SpanHours!,
      r07MealMinutes: r07MealMinutes!,
      r04Threshold: r04Threshold!,
      watchKeywords: watchKeywords!,
    },
  };
}

function intInRange(v: unknown, min: number, max: number, label: string, range: string, errors: string[]): number | undefined {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    errors.push(`${label}은(는) 정수여야 합니다.`);
    return undefined;
  }
  if (v < min || v > max) {
    errors.push(`${label}은(는) ${range} 범위여야 합니다.`);
    return undefined;
  }
  return v;
}

function intMap(v: unknown, errors: string[]): AccountSettings['weights'] | undefined {
  if (typeof v !== 'object' || v === null) {
    errors.push('출시 준비도 가중치는 4개 등급 값을 담은 객체여야 합니다.');
    return undefined;
  }
  const rec = v as Record<string, unknown>;
  const out: Record<string, number> = {};
  let ok = true;
  for (const sev of SEVERITIES) {
    const n = rec[sev];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 100) {
      errors.push(`가중치 ${sev}은(는) 0~100 정수여야 합니다.`);
      ok = false;
    } else {
      out[sev] = n;
    }
  }
  return ok ? (out as AccountSettings['weights']) : undefined;
}

function keywords(v: unknown, errors: string[]): string[] | undefined {
  if (v === undefined) return [];
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
