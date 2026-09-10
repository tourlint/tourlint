import type { JsonSchema } from '../external/llm/llm.types';
import { MAX_DAY, MAX_ITEMS, TIME_RE, TYPE_MAP, type ParseResult, type ParsedItem, type RowError } from './schedule-parse';

/**
 * 자연어 붙여넣기 정형화 (F01 · FR-IN-003 · UI-S2-001 · 010).
 *
 * **순수 함수다.** LLM 호출은 밖에서 하고 여기는 그 출력만 받는다 — 모델 없이도 결정론적으로
 * 검증할 수 있어야 한다 (NF-MT-001 과 같은 이유).
 *
 * ## 검증 규칙을 업로드와 공유한다
 *
 * 일차 상한 · 항목 상한 · 시각 형식 · 유형 6종은 `schedule-parse` 에서 가져온다. 두 경로가
 * 각자 규칙을 들고 있으면 어긋난다 — 엑셀로는 되고 자연어로는 안 되는 일정이 생긴다.
 *
 * 문구는 나눈다. 자연어에는 「행 번호」가 없고 `TEMPLATE_MISMATCH` 같은 사유도 뜻이 없다.
 */

/** 붙여넣기 상한. 한 상품 일정을 담기에 넉넉하고, 문서를 통째로 붙이는 것은 막는다 */
export const NL_MAX_CHARS = 4000;

/** 모델에게 받을 모양. 고정해 보내고 이 모양으로 받는다 (EI-LM-002) */
export const NL_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          day: { type: 'integer', description: '1-기반 일차' },
          start: { type: 'string', description: 'HH:MM 24시간제' },
          end: { type: ['string', 'null'], description: 'HH:MM 또는 null. 적혀 있지 않으면 null' },
          place: { type: 'string', description: '장소명. 원문에 적힌 그대로' },
          type: { type: 'string', enum: ['관광', '식사', '숙박', '휴식', '이동', '자유'] },
        },
        required: ['day', 'start', 'place', 'type'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

/**
 * 모델 지시. **계정 정보 · 인증키 · 타 상품 데이터를 담지 않는다** (EI-LM-004).
 *
 * 없는 값을 지어내지 말라고 명시한다 — 모르는 건 모른다고 하는 것이 4대 원칙 3번이고,
 * 시각을 추측해 채우면 사용자는 자기가 안 쓴 일정을 저장하게 된다.
 */
export const NL_SYSTEM = [
  '너는 여행 일정 텍스트를 표 형태로 옮기는 도구다.',
  '입력에 적힌 것만 옮긴다. 없는 항목·시각·장소를 지어내지 않는다.',
  '종료 시각이 적혀 있지 않으면 end 를 null 로 둔다. 추정하지 않는다.',
  '"오전 10시" 는 10:00, "저녁 6시" 는 18:00 처럼 24시간제로 바꾼다.',
  '일차가 적혀 있지 않으면 1일차로 둔다.',
  '유형은 관광 · 식사 · 숙박 · 휴식 · 이동 · 자유 중에서만 고른다. 판단이 서지 않으면 관광이다.',
].join('\n');

interface RawItem {
  day?: unknown;
  start?: unknown;
  end?: unknown;
  place?: unknown;
  type?: unknown;
}

function rejected(code: string, message: string): ParseResult {
  return { nights: 0, items: [], errors: [], rejected: { code, message } };
}

/**
 * 모델 출력 → 저장 전 편집용 결과.
 *
 * **실패한 항목은 버리되 몇 번째인지와 사유를 남기고 정상 항목은 유지한다** — 업로드와 같은
 * 태도다 (FR-IN-015). 하나도 못 건지면 거부한다. 빈 상품을 만들지 않는다 (EX-IN-010).
 */
export function toParseResult(value: unknown): ParseResult {
  const raw = (value as { items?: unknown } | null)?.items;
  if (!Array.isArray(raw)) {
    return rejected('NL_STRUCTURE_FAILED', '일정으로 읽을 수 있는 내용을 찾지 못했습니다. 직접 입력하거나 지정 양식으로 올려 주세요.');
  }
  if (raw.length > MAX_ITEMS) {
    return rejected('UPLOAD_LIMIT_EXCEEDED', `일정 항목이 ${String(raw.length)}개입니다. 한 상품에 ${String(MAX_ITEMS)}개까지 담을 수 있습니다.`);
  }

  const items: ParsedItem[] = [];
  const errors: RowError[] = [];

  raw.forEach((entry, i) => {
    // 사용자에게는 「N번째 항목」이다. 자연어에는 행 번호가 없다
    const at = i + 1;
    const it = entry as RawItem;
    const day = Number(it.day ?? 1);
    const start = String(it.start ?? '').trim();
    const endRaw = it.end === null || it.end === undefined ? '' : String(it.end).trim();
    const place = String(it.place ?? '').trim();
    const itemType = TYPE_MAP[String(it.type ?? '').trim()];

    if (!Number.isInteger(day) || day < 1 || day > MAX_DAY) {
      errors.push({ row: at, reason: `일차를 1~${String(MAX_DAY)} 사이로 읽지 못했습니다` });
      return;
    }
    if (!TIME_RE.test(start)) {
      errors.push({ row: at, reason: '시작 시각을 읽지 못했습니다' });
      return;
    }
    if (endRaw !== '' && !TIME_RE.test(endRaw)) {
      errors.push({ row: at, reason: '종료 시각을 읽지 못했습니다' });
      return;
    }
    if (place === '') {
      errors.push({ row: at, reason: '장소명이 비어 있습니다' });
      return;
    }
    if (itemType === undefined) {
      errors.push({ row: at, reason: '유형을 관광·식사·숙박·휴식·이동·자유 중에서 읽지 못했습니다' });
      return;
    }
    items.push({ day, start, end: endRaw === '' ? null : endRaw, place, itemType });
  });

  if (items.length === 0) {
    return rejected('NL_STRUCTURE_FAILED', '일정으로 읽을 수 있는 항목이 없습니다. 직접 입력하거나 지정 양식으로 올려 주세요.');
  }

  items.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
  return { nights: Math.max(...items.map((i) => i.day)) - 1, items, errors };
}
