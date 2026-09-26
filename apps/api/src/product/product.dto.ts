import {
  INPUT_ITEM_ORIGIN, ITEM_CAP_MESSAGE, ITEM_TYPE, MAX_ITEMS_PER_PRODUCT, TRANSPORT, isConceptKey, isTargetKey,
  type InputItemOrigin, type ItemType, type Transport,
} from '@tourlint/shared';

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
  // 입력하는 순간 목록에서 고른 관광지 (UI-S2-020). 있으면 CONFIRMED 로 저장한다 — 이름은 담지 않는다
  readonly content?: unknown;
  // 그 줄이 들어온 경로 (FR-PL-020). MANUAL · UPLOAD · TEXT · PICKER, 없으면 MANUAL
  readonly origin?: unknown;
  // 「찾는 곳이 없나요? 직접 정한 곳으로 두기」를 고른 줄이면 true — EXCLUDED 로 저장한다 (UI-S2-021)
  readonly excluded?: unknown;
}

/** 등록 시 인라인으로 고른 관광지 (UI-S2-020 · D8). 코드·좌표·분류만 담는다 (DR-PR-001) */
export interface MatchedContent {
  readonly contentId: string;
  readonly contentTypeId: number;
  readonly mapx: number | null;
  readonly mapy: number | null;
  readonly lcls1: string | null;
  readonly lcls2: string | null;
  readonly lcls3: string | null;
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
  readonly planOrigin?: unknown;
}

/**
 * 기획 출처 (DR-PR-009). 어떻게 시작했는지 · 신호 종류 · 지역 코드 · 기간 · contentid 만 담는다.
 * 공사 원문(제목 · 주소)은 넣지 않는다.
 */
export interface PlanOrigin {
  readonly startedBy: 'MANUAL' | 'UPLOAD' | 'TEXT' | 'SIGNAL';
  readonly signal?: {
    readonly type: string;
    readonly regnCd: string;
    readonly signguCd: string | null;
    readonly from: string;
    readonly to: string;
    readonly contentId?: string;
  };
}

// 'CLONE' 은 뺐다 — 기존 상품 복사는 만들지 않기로 했고 FR-CM-007 도 삭제했다 (#615).
// 옛 기록에 남아 있을 수 있어 화면은 그 값을 계속 읽는다. 새로 들어오는 것만 막는다
const STARTED_BY = ['MANUAL', 'UPLOAD', 'TEXT', 'SIGNAL'] as const;

/** 검증을 통과한 항목 — 저장 계층이 그대로 쓴다 */
export interface ValidItem {
  readonly dayNo: number;
  readonly seq: number;
  readonly startTime: string;
  readonly endTime: string | null;
  readonly endTimeSource: 'INPUT' | 'DWELL_DEFAULT';
  readonly placeLabel: string;
  readonly itemType: ItemType;
  // 등록 시 고른 관광지. null = 아직 안 고름(PENDING), 있으면 CONFIRMED (UI-S2-020)
  readonly content: MatchedContent | null;
  /** 들어온 경로 (FR-PL-020). 장소 담기(PICKER)로 넣은 줄은 고른 방식(matched_by)을 비운다 */
  readonly origin: InputItemOrigin;
  /** 직접 정한 곳(EXCLUDED)으로 둔 줄 (UI-S2-021 · FR-IN-025). 고른 관광지가 있으면 무시한다 */
  readonly excluded: boolean;
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
  readonly planOrigin: PlanOrigin | null;
  readonly items: readonly ValidItem[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 줄이 들어온 경로 (FR-PL-020). 기록일 뿐이라 저장을 막지 않는다 — 없거나 목록에 없는 값이면
 * 직접 입력(MANUAL)으로 둔다. 화면을 거치지 않고 API 로 넣은 줄도 사람이 친 줄이다.
 */
function readOrigin(v: unknown): InputItemOrigin {
  const s = str(v);
  return (INPUT_ITEM_ORIGIN as readonly string[]).includes(s) ? (s as InputItemOrigin) : 'MANUAL';
}

/**
 * 타깃 · 콘셉트는 표준 키만 받는다 (FR-PL-003 · DR-IN-015). 자유 입력이던 것을 목록 선택으로
 * 바꿔 R10 이 표준 프로파일과 맞춰볼 수 있게 한다. 빈 값은 null, 목록에 없는 값은 오류다.
 */
function keyOrNull(v: unknown, isValid: (x: unknown) => boolean, label: string, errors: string[]): string | null {
  const s = str(v);
  if (s === '') return null;
  if (!isValid(s)) {
    errors.push(`${label}은(는) 목록에서 골라 주세요.`);
    return null;
  }
  return s;
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

  const targetKey = keyOrNull(dto.targetKey, isTargetKey, '타깃', errors);
  const conceptKey = keyOrNull(dto.conceptKey, isConceptKey, '콘셉트', errors);

  const items = validateDays(dto.days, nights, errors);
  // 업로드 · 메모 읽기만 막고 직접 입력은 46건 이상도 저장됐다 (NF-CP-003 · NF-CP-010 · #892)
  if (items.length > MAX_ITEMS_PER_PRODUCT) errors.push(ITEM_CAP_MESSAGE);

  if (errors.length > 0) return { errors, product: null };
  return {
    errors,
    product: {
      name,
      ldongRegnCd,
      ldongSignguCd,
      startDate,
      nights,
      targetKey,
      conceptKey,
      planOrigin: parsePlanOrigin(dto.planOrigin),
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

/**
 * 기획 출처를 걸러 담는다. 모양이 틀리면 조용히 null — 출처는 기록일 뿐이라 상품 생성을
 * 막지 않는다. 알려진 필드만 옮겨 공사 원문이 새지 않게 한다 (DR-PR-009).
 */
function parsePlanOrigin(v: unknown): PlanOrigin | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const startedBy = o.startedBy;
  if (typeof startedBy !== 'string' || !(STARTED_BY as readonly string[]).includes(startedBy)) return null;
  const out: PlanOrigin = { startedBy: startedBy as PlanOrigin['startedBy'] };
  const s = o.signal;
  if (typeof s === 'object' && s !== null) {
    const sig = s as Record<string, unknown>;
    if (typeof sig.type === 'string' && typeof sig.regnCd === 'string'
        && typeof sig.from === 'string' && typeof sig.to === 'string') {
      return {
        startedBy: out.startedBy,
        signal: {
          type: sig.type,
          regnCd: sig.regnCd,
          signguCd: typeof sig.signguCd === 'string' ? sig.signguCd : null,
          from: sig.from,
          to: sig.to,
          ...(typeof sig.contentId === 'string' ? { contentId: sig.contentId } : {}),
        },
      };
    }
  }
  return out;
}

/** 검수 시작(handoff) 본문. `excludePending: true` 면 남은 미확정을 검수 제외로 넘긴다 (D7) */
export function validateHandoff(body: unknown): { excludePending: boolean } {
  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  return { excludePending: b.excludePending === true };
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
  if (dto.targetKey !== undefined) update.targetKey = keyOrNull(dto.targetKey, isTargetKey, '타깃', errors);
  if (dto.conceptKey !== undefined) update.conceptKey = keyOrNull(dto.conceptKey, isConceptKey, '콘셉트', errors);
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
 * 일정 검증 (기획 중 저장 · EX-IN-005 개정). 저장 시점에는 빈 일차 · 빈 일정을 허용한다 —
 * 상품을 기획 중으로 일찍 만들고 항목을 이어서 채우기 때문이다(빈 상품 즉시 생성). **박수↔일정
 * 완성도(빈 일차 없음)는 검수 시작(handoff)이 검사한다** — 저장이 아니라 그 시점의 관문이다.
 * 여기서는 있는 항목만 검증하고, 박수 범위를 넘는 일차의 항목은 거부한다(데이터 정합).
 */
function validateDays(rawDays: unknown, nights: number, errors: string[]): ValidItem[] {
  const items: ValidItem[] = [];
  if (!Array.isArray(rawDays)) return items; // 빈 초안 — 일정 없이 기획 중으로 저장

  const expectedDays = Number.isInteger(nights) && nights >= 0 ? nights + 1 : rawDays.length;

  rawDays.forEach((rawDay, index) => {
    const dayNo = index + 1;
    const day = (rawDay ?? {}) as CreateDayDto;
    const rawItems = Array.isArray(day.items) ? day.items : [];
    // 박수 범위를 넘는 일차에 항목이 있으면 거부한다 (예: 2박 3일에 4일차)
    if (dayNo > expectedDays) {
      if (rawItems.length > 0) errors.push(`${dayNo}일차는 박수(${nights}) 범위를 벗어납니다.`);
      return;
    }
    // 빈 일차는 그냥 건너뛴다 — 검수 시작에서 완성도를 본다
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

      // 입력하는 순간 고른 관광지 (UI-S2-020). 있으면 CONFIRMED 로 저장한다. 좌표·분류는 있으면 담는다
      let content: MatchedContent | null = null;
      if (typeof item.content === 'object' && item.content !== null) {
        const c = item.content as Record<string, unknown>;
        const contentId = str(c.contentId);
        const contentTypeId = typeof c.contentTypeId === 'number' ? c.contentTypeId : Number(c.contentTypeId);
        if (contentId === '' || !Number.isInteger(contentTypeId)) {
          errors.push(`${dayNo}일차 ${seq}번 고른 장소 정보가 올바르지 않습니다.`);
        } else {
          content = {
            contentId,
            contentTypeId,
            mapx: numOrNull(c.mapx),
            mapy: numOrNull(c.mapy),
            lcls1: strOrNull(c.lcls1),
            lcls2: strOrNull(c.lcls2),
            lcls3: strOrNull(c.lcls3),
          };
        }
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
        content,
        origin: readOrigin(item.origin),
        // 관광지를 고른 줄은 고른 곳이다 — 둘 다 오면 고른 쪽을 따른다
        excluded: item.excluded === true && content === null,
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
  /** 편집 화면에서 친 줄은 MANUAL, 엑셀 · 메모로 채운 줄은 UPLOAD · TEXT (FR-PL-020) */
  origin: InputItemOrigin;
  /** 「직접 정한 곳으로 두기」를 고른 새 줄 — EXCLUDED 로 넣는다 (UI-S2-021) */
  excluded: boolean;
}

/** 장소 담기로 넣는 항목 — 이미 고른 공사 콘텐츠라 CONFIRMED 로 들어간다 (D8 · FR-PL-013) */
export interface PickedItemInput {
  dayNo: number;
  itemType: ItemType;
  origin: 'PICKER';
  /** 넣을 위치 — 이 항목 다음에 삽입한다 (4-3). 없으면 그 날 끝에 붙인다 */
  afterItemId: number | null;
  content: {
    contentId: string;
    contentTypeId: number;
    lcls1: string | null;
    lcls2: string | null;
    lcls3: string | null;
    mapx: number | null;
    mapy: number | null;
  };
}

interface RawItem {
  dayNo?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  placeLabel?: unknown;
  itemType?: unknown;
  origin?: unknown;
  /** true 면 직접 정한 곳. 걷기 길의 `excluded: { walkId }` 는 `validateWalkItem` 이 받는다 */
  excluded?: unknown;
}

/**
 * 장소 담기 넣기 검증 (FR-PL-013). 고른 공사 콘텐츠(content) · 일차 · 항목 유형만 받는다.
 * 시각 · 좌표는 서버가 채운다 — 공사 원문(제목 · 주소)은 저장하지 않는다.
 */
export function validatePickedItem(body: Record<string, unknown> | undefined, dayCount: number): { errors: string[]; picked?: PickedItemInput } {
  const errors: string[] = [];
  const b = body ?? {};
  const dayNo = typeof b.dayNo === 'number' && Number.isInteger(b.dayNo) ? b.dayNo : 0;
  if (dayNo < 1 || dayNo > dayCount) errors.push(`일차는 1~${dayCount} 범위여야 합니다.`);
  const itemType = str(b.itemType);
  if (!(ITEM_TYPE as readonly string[]).includes(itemType)) errors.push('항목 유형이 올바르지 않습니다.');
  const c = b.content;
  if (typeof c !== 'object' || c === null) {
    errors.push('넣을 장소 정보가 필요합니다.');
    return { errors };
  }
  const cc = c as Record<string, unknown>;
  const contentId = str(cc.contentId);
  const contentTypeId = typeof cc.contentTypeId === 'number' ? cc.contentTypeId : Number(cc.contentTypeId);
  if (contentId === '') errors.push('contentId 가 필요합니다.');
  if (!Number.isInteger(contentTypeId)) errors.push('contentTypeId 가 올바르지 않습니다.');
  // 넣을 위치는 선택이다 — 있으면 양의 정수여야 하고, 없으면 그 날 끝에 붙인다
  const afterItemId = b.afterItemId === undefined || b.afterItemId === null
    ? null
    : (typeof b.afterItemId === 'number' && Number.isInteger(b.afterItemId) && b.afterItemId > 0 ? b.afterItemId : 0);
  if (afterItemId === 0) errors.push('넣을 위치가 올바르지 않습니다.');
  if (errors.length > 0) return { errors };
  return {
    errors,
    picked: {
      dayNo,
      itemType: itemType as ItemType,
      origin: 'PICKER',
      afterItemId,
      content: {
        contentId,
        contentTypeId,
        lcls1: strOrNull(cc.lcls1),
        lcls2: strOrNull(cc.lcls2),
        lcls3: strOrNull(cc.lcls3),
        mapx: numOrNull(cc.mapx),
        mapy: numOrNull(cc.mapy),
      },
    },
  };
}

/** 걷기 길로 넣는 항목 (D9 · FR-PL-015). 코스 식별자만 저장하고 이름은 저장하지 않는다 */
export interface WalkItemInput {
  dayNo: number;
  itemType: ItemType;
  origin: 'PICKER';
  walkId: string;
}

export function validateWalkItem(body: Record<string, unknown> | undefined, dayCount: number): { errors: string[]; walk?: WalkItemInput } {
  const errors: string[] = [];
  const b = body ?? {};
  const dayNo = typeof b.dayNo === 'number' && Number.isInteger(b.dayNo) ? b.dayNo : 0;
  if (dayNo < 1 || dayNo > dayCount) errors.push(`일차는 1~${dayCount} 범위여야 합니다.`);
  const itemType = str(b.itemType) === '' ? 'SIGHT' : str(b.itemType);
  if (!(ITEM_TYPE as readonly string[]).includes(itemType)) errors.push('항목 유형이 올바르지 않습니다.');
  const excluded = b.excluded as Record<string, unknown> | undefined;
  const walkId = str(excluded?.walkId);
  if (walkId === '') errors.push('걷기 길 식별자가 필요합니다.');
  if (errors.length > 0) return { errors };
  return { errors, walk: { dayNo, itemType: itemType as ItemType, origin: 'PICKER', walkId } };
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}
function numOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
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
      origin: readOrigin(b.origin),
      excluded: b.excluded === true,
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
