import { ITEM_TYPE, TRANSPORT, type ItemType, type Transport } from '@tourlint/shared';

/**
 * 상품 등록·편집 요청 계약과 검증 (F01 · API 설계 5-1).
 *
 * 필드명·enum 은 API 설계 문서를 정본으로 따른다 — `ldongRegnCd` · `transport: 'CAR'`.
 * 웹 폼이 보내던 `regnCd` · `'car'` 는 mock 시절 계약이라 함께 맞춘다.
 *
 * 검증은 순수 함수다. 저장 전에 서버가 다시 본다 — 클라이언트 검증만으로는 API 직접 호출을
 * 막지 못한다 (EX-IN-005 · PM-AC-004).
 */

export interface CreateItemDto {
  readonly start?: unknown;
  readonly end?: unknown;
  readonly place?: unknown;
  readonly itemType?: unknown;
}

export interface CreateDayDto {
  readonly day?: unknown;
  readonly items?: unknown;
}

export interface CreateProductDto {
  readonly name?: unknown;
  readonly ldongRegnCd?: unknown;
  readonly ldongSignguCd?: unknown;
  readonly startDate?: unknown;
  readonly nights?: unknown;
  readonly targetKey?: unknown;
  readonly conceptKey?: unknown;
  readonly headCount?: unknown;
  readonly transport?: unknown;
  readonly days?: unknown;
}

/** 검증을 통과한 항목 — 저장 계층이 그대로 쓴다 */
export interface ValidItem {
  readonly dayNo: number;
  readonly seq: number;
  readonly startTime: string;
  readonly endTime: string | null;
  readonly endTimeSource: 'INPUT' | 'DWELL_DEFAULT';
  readonly placeLabel: string;
  readonly itemType: ItemType;
}

export interface ValidProduct {
  readonly name: string;
  readonly ldongRegnCd: string;
  readonly ldongSignguCd: string | null;
  readonly startDate: string;
  readonly nights: number;
  readonly targetKey: string | null;
  readonly conceptKey: string | null;
  readonly headCount: number | null;
  readonly transport: Transport;
  readonly items: readonly ValidItem[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 상품 생성 요청을 검증하고 저장용 형태로 바꾼다. 오류가 있으면 `errors` 가 비지 않는다 —
 * 이때 `product` 는 신뢰하지 않는다.
 */
export function validateCreate(dto: CreateProductDto): { errors: string[]; product: ValidProduct | null } {
  const errors: string[] = [];

  const name = str(dto.name);
  if (name === '') errors.push('상품명을 입력하세요.');

  const ldongRegnCd = str(dto.ldongRegnCd);
  if (ldongRegnCd === '') errors.push('여행 지역(시도)을 선택하세요.');
  const ldongSignguCd = str(dto.ldongSignguCd) || null;

  const startDate = str(dto.startDate);
  if (!ISO_DATE.test(startDate)) errors.push('출발일을 YYYY-MM-DD 형식으로 입력하세요.');

  const nights = Number(dto.nights);
  if (!Number.isInteger(nights) || nights < 0 || nights > 2) {
    errors.push('박수는 0·1·2 중 하나여야 합니다.');
  }

  const transport = str(dto.transport);
  if (!(TRANSPORT as readonly string[]).includes(transport)) {
    errors.push(`이동수단이 올바르지 않습니다 (${TRANSPORT.join(' · ')}).`);
  }

  let headCount: number | null = null;
  if (dto.headCount !== undefined && dto.headCount !== null && dto.headCount !== '') {
    headCount = Number(dto.headCount);
    if (!Number.isInteger(headCount) || headCount <= 0) errors.push('예상 인원은 1 이상의 정수여야 합니다.');
  }

  const items = validateDays(dto.days, nights, errors);

  if (errors.length > 0) return { errors, product: null };
  return {
    errors,
    product: {
      name,
      ldongRegnCd,
      ldongSignguCd,
      startDate,
      nights,
      targetKey: str(dto.targetKey) || null,
      conceptKey: str(dto.conceptKey) || null,
      headCount,
      transport: transport as Transport,
      items,
    },
  };
}

export interface UpdateProductDto {
  readonly name?: unknown;
  readonly targetKey?: unknown;
  readonly conceptKey?: unknown;
  readonly headCount?: unknown;
  readonly transport?: unknown;
  readonly startDate?: unknown;
}

export interface ValidUpdate {
  readonly name?: string;
  readonly targetKey?: string | null;
  readonly conceptKey?: string | null;
  readonly headCount?: number | null;
  readonly transport?: Transport;
  readonly startDate?: string;
}

/** 기본정보 부분 수정 검증. 준 필드만 본다 — 박수·일정 구조는 여기서 바꾸지 않는다 */
export function validateUpdate(dto: UpdateProductDto): { errors: string[]; update: ValidUpdate } {
  const errors: string[] = [];
  const update: {
    name?: string;
    targetKey?: string | null;
    conceptKey?: string | null;
    headCount?: number | null;
    transport?: Transport;
    startDate?: string;
  } = {};

  if (dto.name !== undefined) {
    const name = str(dto.name);
    if (name === '') errors.push('상품명은 비울 수 없습니다.');
    else update.name = name;
  }
  if (dto.targetKey !== undefined) update.targetKey = str(dto.targetKey) || null;
  if (dto.conceptKey !== undefined) update.conceptKey = str(dto.conceptKey) || null;
  if (dto.headCount !== undefined) {
    if (dto.headCount === null || dto.headCount === '') {
      update.headCount = null;
    } else {
      const n = Number(dto.headCount);
      if (!Number.isInteger(n) || n <= 0) errors.push('예상 인원은 1 이상의 정수여야 합니다.');
      else update.headCount = n;
    }
  }
  if (dto.transport !== undefined) {
    const t = str(dto.transport);
    if (!(TRANSPORT as readonly string[]).includes(t)) errors.push(`이동수단이 올바르지 않습니다 (${TRANSPORT.join(' · ')}).`);
    else update.transport = t as Transport;
  }
  if (dto.startDate !== undefined) {
    const d = str(dto.startDate);
    if (!ISO_DATE.test(d)) errors.push('출발일을 YYYY-MM-DD 형식으로 입력하세요.');
    else update.startDate = d;
  }

  return { errors, update };
}

/**
 * 일정 검증. 박수와 일수(=박수+1)가 맞아야 하고 빈 일차가 없어야 한다 (EX-IN-005 · 빈 상품 생성 금지).
 */
function validateDays(rawDays: unknown, nights: number, errors: string[]): ValidItem[] {
  const items: ValidItem[] = [];
  if (!Array.isArray(rawDays)) {
    errors.push('일정을 입력하세요.');
    return items;
  }

  const expectedDays = Number.isInteger(nights) && nights >= 0 ? nights + 1 : rawDays.length;
  if (rawDays.length !== expectedDays) {
    errors.push(`일정은 ${expectedDays}일치여야 합니다 (박수 ${nights}).`);
  }

  rawDays.forEach((rawDay, index) => {
    const dayNo = index + 1;
    const day = (rawDay ?? {}) as CreateDayDto;
    const rawItems = Array.isArray(day.items) ? day.items : [];
    if (rawItems.length === 0) {
      errors.push(`${dayNo}일차 일정을 1개 이상 입력하세요.`);
      return;
    }
    rawItems.forEach((rawItem, itemIndex) => {
      const item = (rawItem ?? {}) as CreateItemDto;
      const seq = itemIndex + 1;
      const place = str(item.place);
      const start = str(item.start);
      const endRaw = str(item.end);
      const itemType = str(item.itemType);

      if (place === '') errors.push(`${dayNo}일차 ${seq}번 장소명을 입력하세요.`);
      if (!HHMM.test(start)) errors.push(`${dayNo}일차 ${seq}번 시작 시각이 올바르지 않습니다.`);
      if (endRaw !== '' && !HHMM.test(endRaw)) errors.push(`${dayNo}일차 ${seq}번 종료 시각이 올바르지 않습니다.`);
      if (!(ITEM_TYPE as readonly string[]).includes(itemType)) {
        errors.push(`${dayNo}일차 ${seq}번 항목 유형이 올바르지 않습니다.`);
      }

      items.push({
        dayNo,
        seq,
        startTime: start,
        endTime: endRaw === '' ? null : endRaw,
        // 종료 시각이 있으면 입력값, 없으면 기본 체류시간 보완 대상 (FR-IN-011)
        endTimeSource: endRaw === '' ? 'DWELL_DEFAULT' : 'INPUT',
        placeLabel: place,
        itemType: itemType as ItemType,
      });
    });
  });

  return items;
}

// ── 일정 항목 개별 CRUD (F01 · FR-IN-013/014) ────────────────────────────────

export interface ValidItemInput {
  dayNo: number;
  startTime: string;
  endTime: string | null;
  endTimeSource: 'INPUT' | 'DWELL_DEFAULT';
  placeLabel: string;
  itemType: ItemType;
}

interface RawItem {
  dayNo?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  placeLabel?: unknown;
  itemType?: unknown;
}

/** 항목 추가. dayNo 는 1~dayCount, 나머지는 등록 때와 같은 규칙. */
export function validateAddItem(body: RawItem | undefined, dayCount: number): { errors: string[]; item?: ValidItemInput } {
  const errors: string[] = [];
  const b = body ?? {};
  const dayNo = typeof b.dayNo === 'number' && Number.isInteger(b.dayNo) ? b.dayNo : 0;
  if (dayNo < 1 || dayNo > dayCount) errors.push(`일차는 1~${dayCount} 범위여야 합니다.`);
  const start = str(b.startTime);
  const endRaw = str(b.endTime);
  const place = str(b.placeLabel);
  const itemType = str(b.itemType);
  if (!HHMM.test(start)) errors.push('시작 시각을 HH:MM 형식으로 입력하세요.');
  if (endRaw !== '' && !HHMM.test(endRaw)) errors.push('종료 시각을 HH:MM 형식으로 입력하세요.');
  if (place === '') errors.push('장소명을 입력하세요.');
  if (!(ITEM_TYPE as readonly string[]).includes(itemType)) errors.push('항목 유형이 올바르지 않습니다.');
  if (errors.length > 0) return { errors };
  return {
    errors,
    item: {
      dayNo,
      startTime: start,
      endTime: endRaw === '' ? null : endRaw,
      endTimeSource: endRaw === '' ? 'DWELL_DEFAULT' : 'INPUT',
      placeLabel: place,
      itemType: itemType as ItemType,
    },
  };
}

export interface ItemPatch {
  startTime?: string;
  endTime?: string | null;
  endTimeSource?: 'INPUT' | 'DWELL_DEFAULT';
  placeLabel?: string;
  itemType?: ItemType;
}

/** 항목 수정. 준 필드만 바꾼다(부분 수정). 일차 · 순서는 순서변경 경로로 다룬다. */
export function validatePatchItem(body: RawItem | undefined): { errors: string[]; patch?: ItemPatch } {
  const errors: string[] = [];
  const b = body ?? {};
  const patch: ItemPatch = {};
  if (b.startTime !== undefined) {
    const s = str(b.startTime);
    if (!HHMM.test(s)) errors.push('시작 시각을 HH:MM 형식으로 입력하세요.');
    else patch.startTime = s;
  }
  if (b.endTime !== undefined) {
    const e = str(b.endTime);
    if (e !== '' && !HHMM.test(e)) errors.push('종료 시각을 HH:MM 형식으로 입력하세요.');
    else {
      patch.endTime = e === '' ? null : e;
      patch.endTimeSource = e === '' ? 'DWELL_DEFAULT' : 'INPUT';
    }
  }
  if (b.placeLabel !== undefined) {
    const p = str(b.placeLabel);
    if (p === '') errors.push('장소명은 비울 수 없습니다.');
    else patch.placeLabel = p;
  }
  if (b.itemType !== undefined) {
    const t = str(b.itemType);
    if (!(ITEM_TYPE as readonly string[]).includes(t)) errors.push('항목 유형이 올바르지 않습니다.');
    else patch.itemType = t as ItemType;
  }
  if (errors.length > 0) return { errors };
  if (Object.keys(patch).length === 0) return { errors: ['바꿀 값이 없습니다.'] };
  return { errors, patch };
}

export interface ItemOrder {
  itemId: number;
  dayNo: number;
  seq: number;
}

/** 순서변경. 상품 항목들의 새 (일차 · 순서)를 통째로 받는다. */
export function validateOrder(body: { items?: unknown } | undefined, dayCount: number): { errors: string[]; order?: ItemOrder[] } {
  const errors: string[] = [];
  const raw = body?.items;
  if (!Array.isArray(raw)) return { errors: ['items 는 {itemId, dayNo, seq} 목록이어야 합니다.'] };
  const order: ItemOrder[] = [];
  const seenId = new Set<number>();
  const seenPos = new Set<string>();
  for (const r of raw as { itemId?: unknown; dayNo?: unknown; seq?: unknown }[]) {
    const itemId = typeof r.itemId === 'number' && Number.isInteger(r.itemId) ? r.itemId : 0;
    const dayNo = typeof r.dayNo === 'number' && Number.isInteger(r.dayNo) ? r.dayNo : 0;
    const seq = typeof r.seq === 'number' && Number.isInteger(r.seq) ? r.seq : 0;
    if (itemId < 1) errors.push('itemId 가 올바르지 않습니다.');
    else if (seenId.has(itemId)) errors.push(`itemId 가 중복됐습니다: ${itemId}`);
    if (dayNo < 1 || dayNo > dayCount) errors.push(`일차는 1~${dayCount} 범위여야 합니다.`);
    if (seq < 1) errors.push('순서(seq)는 1 이상이어야 합니다.');
    const pos = `${dayNo}:${seq}`;
    if (seenPos.has(pos)) errors.push(`같은 자리에 두 항목을 둘 수 없습니다 (${dayNo}일차 ${seq}번).`);
    seenId.add(itemId);
    seenPos.add(pos);
    order.push({ itemId, dayNo, seq });
  }
  if (errors.length > 0) return { errors };
  return { errors, order };
}
