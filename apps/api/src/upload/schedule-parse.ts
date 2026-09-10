import { ITEM_TYPE, type ItemType } from '@tourlint/shared';

/**
 * 지정 양식(엑셀·CSV) 일정 파싱 (F01 · UI-S2-010·011 · FR-IN-015).
 *
 * 순수 함수다 — 파일 읽기(xlsx)는 밖에서 하고, 여기는 셀 행렬만 받는다. 그래야 fixtures/excel
 * 샘플을 그대로 먹여 결정론적으로 검증할 수 있다.
 *
 * 규칙: 실패한 행은 **버리되 번호와 사유를 남기고 정상 행은 유지**한다 (FR-IN-015). 일차가
 * 박수 범위(최대 2박 3일 = 3일차)를 넘으면 파일 전체를 거부한다 (SC-PD-001).
 */

/** 양식 유형(한글) → 엔진 항목 유형 코드. 양식은 이 6종만 허용한다 */
export const TYPE_MAP: Record<string, ItemType> = {
  관광: 'SIGHT',
  식사: 'MEAL',
  숙박: 'LODGING',
  휴식: 'REST',
  이동: 'MOVE',
  자유: 'FREE',
};

/** 당일(0) ~ 2박 3일(2) → 최대 3일차 (SC-PD-001) */
export const MAX_DAY = 3;
/** 업로드 상한. 행은 파싱 전, 유효 항목은 파싱 후에 본다 (EX-IN-003 · 004 · NF-CP-003) */
const MAX_ROWS = 500;
export const MAX_ITEMS = 45;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const HEADER_TOKENS = ['일차', '시작시간', '종료시간', '장소명', '유형'];

export interface ParsedItem {
  day: number;
  start: string;
  end: string | null; // 비우면 기본 체류시간 보완 대상 (FR-IN-011)
  place: string;
  itemType: ItemType;
}

export interface RowError {
  row: number; // 1-기반 원본 행 번호 (사용자가 파일에서 찾을 수 있게)
  reason: string;
}

export interface ParseResult {
  nights: number; // 최대 일차 - 1
  items: readonly ParsedItem[]; // 정상 행만
  errors: readonly RowError[];
  /** 파일 전체가 거부된 경우. 그 외엔 undefined */
  rejected?: { code: string; message: string };
}

type Cell = string | number | null | undefined;

/**
 * 셀 행렬 하나를 파싱한다. `rows[i]` 는 한 행, `rows[i][c]` 는 A..E 열.
 * 원본 행 번호는 `i + 1`(1-기반)로 보고한다.
 */
export function parseSchedule(rows: readonly (readonly Cell[])[]): ParseResult {
  // 행 상한은 파싱 전에 본다 (EX-IN-003)
  if (rows.length > MAX_ROWS) {
    return {
      nights: 0,
      items: [],
      errors: [],
      rejected: {
        code: 'UPLOAD_LIMIT_EXCEEDED',
        message: `행이 ${rows.length}개입니다. 한 번에 ${MAX_ROWS}행까지 올릴 수 있습니다.`,
      },
    };
  }

  const header = locateHeader(rows);
  if (header.idx === -1) {
    return {
      nights: 0,
      items: [],
      errors: [],
      rejected: {
        code: 'TEMPLATE_MISMATCH',
        message: '지정 양식이 아닙니다. 헤더(일차·시작시간·종료시간·장소명·유형)를 찾을 수 없습니다.',
      },
    };
  }
  // 헤더는 찾았지만 일부 컬럼이 빠졌다 — 어느 컬럼인지 짚어 준다 (EX-IN-001)
  if (header.missing.length > 0) {
    return {
      nights: 0,
      items: [],
      errors: [],
      rejected: {
        code: 'TEMPLATE_MISMATCH',
        message: `필수 컬럼이 없습니다: ${header.missing.join(' · ')}. 지정 양식을 내려받아 다시 작성해 주세요.`,
      },
    };
  }

  const items: ParsedItem[] = [];
  const errors: RowError[] = [];

  for (let i = header.idx + 1; i < rows.length; i++) {
    const rowNo = i + 1;
    const row = rows[i] ?? [];
    if (isBlank(row)) continue;

    const parsed = parseRow(row);
    if (typeof parsed === 'string') {
      errors.push({ row: rowNo, reason: parsed });
      continue;
    }
    items.push(parsed);
  }

  const maxDay = items.reduce((m, it) => Math.max(m, it.day), 0);
  if (maxDay > MAX_DAY) {
    return {
      nights: 0,
      items: [],
      errors,
      rejected: {
        code: 'DAY_COUNT_MISMATCH',
        message: `일차가 ${maxDay}까지 있습니다. 검수 대상은 당일~2박 3일(최대 3일차)입니다.`,
      },
    };
  }

  // 유효 항목 상한은 파싱 후에 본다 (EX-IN-004)
  if (items.length > MAX_ITEMS) {
    return {
      nights: 0,
      items: [],
      errors,
      rejected: {
        code: 'UPLOAD_LIMIT_EXCEEDED',
        message: `유효한 일정 항목이 ${items.length}건입니다. 한 상품에 ${MAX_ITEMS}건까지 담을 수 있습니다. 상품을 나눠 주세요.`,
      },
    };
  }

  return { nights: maxDay === 0 ? 0 : maxDay - 1, items, errors };
}

function parseRow(row: readonly Cell[]): ParsedItem | string {
  const day = toInt(row[0]);
  const start = text(row[1]);
  const end = text(row[2]);
  const place = text(row[3]);
  const typeKo = text(row[4]);

  if (day === null || day < 1) return '일차는 1 이상의 숫자여야 합니다.';
  if (!TIME_RE.test(start)) return `시작시간 형식이 올바르지 않습니다(HH:MM): "${start}"`;
  if (end !== '' && !TIME_RE.test(end)) return `종료시간 형식이 올바르지 않습니다(HH:MM): "${end}"`;
  if (place === '') return '장소명이 비어 있습니다.';
  const itemType = TYPE_MAP[typeKo];
  if (itemType === undefined) {
    return `유형은 ${Object.keys(TYPE_MAP).join(' · ')} 중 하나여야 합니다: "${typeKo}"`;
  }
  return { day, start, end: end === '' ? null : end, place, itemType };
}

/**
 * 헤더 행을 찾고, 못 채운 필수 컬럼을 함께 돌려준다.
 *
 * 헤더 토큰이 가장 많이 맞는 행을 헤더로 본다. 하나도 없으면 `idx: -1`(양식 아님),
 * 일부만 있으면 `missing` 에 빠진 컬럼을 담아 어느 것이 없는지 짚을 수 있게 한다 (EX-IN-001).
 */
function locateHeader(rows: readonly (readonly Cell[])[]): { idx: number; missing: string[] } {
  let best = { idx: -1, present: 0, missing: [...HEADER_TOKENS] };
  for (let i = 0; i < rows.length; i++) {
    const cells = (rows[i] ?? []).map((c) => text(c));
    const missing = HEADER_TOKENS.filter((tok) => !cells.includes(tok));
    const present = HEADER_TOKENS.length - missing.length;
    if (present > best.present) best = { idx: i, present, missing };
  }
  return best.present === 0 ? { idx: -1, missing: [...HEADER_TOKENS] } : { idx: best.idx, missing: best.missing };
}

function isBlank(row: readonly Cell[]): boolean {
  return row.every((c) => text(c) === '');
}

function text(c: Cell): string {
  return c === null || c === undefined ? '' : String(c).trim();
}

function toInt(c: Cell): number | null {
  const t = text(c);
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}

/** 엔진 항목 유형 코드 목록 — 양식 유효성 문서화용 (ITEM_TYPE 과 동일) */
export const ALLOWED_ITEM_TYPES: readonly ItemType[] = ITEM_TYPE;
