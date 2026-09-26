import { HttpStatus } from '@nestjs/common';
import { CONTENT_TYPE_ID, LCLS_SYSTM2, type AgentIncomplete, type ContentTypeId, type PlaceSuggestion } from '@tourlint/shared';
import { DomainException } from '../common/domain.exception';
import { BudgetBlockedError } from '../external/budget-guard';
import { isKtoError, type KtoClient, type KtoListPage } from '../external/kto';
import type { LlmClient } from '../external/llm';
import type { PlanItem, PlanItemRepository, PlanProduct } from '../plan/plan-item.repository';
import type { PlanBudget } from '../plan/plan.service';
import { AgentRunner, incompleteReason, type AgentTool } from './agent-runner';
import type { AgentEvidence } from './agent-evidence';
import type { AgentLock } from './agent-lock';

/**
 * 기획 에이전트 — 고르지 않은 줄의 장소 찾기 (FR-AG-010 ~ 012 · API 4-11).
 *
 * 줄의 문구에서 장소 이름을 뽑아 **상품 지역 안에서** 찾고, 여럿이면 하나를 고르고 이유를
 * 한 줄 쓴다. 고르는 것은 사람이다 — 이 서비스는 상품 · 항목을 바꾸지 않는다.
 *
 * ## 서버가 정하는 것
 *
 * 검색 지역은 모델이 정하지 않는다. 상품의 시도 · 시군구를 서버가 붙인다 — 모델이 지역을
 * 넓히면 옆 시군구 관광지가 일정에 묶인다.
 *
 * 제목 · 주소 · 분류도 모델이 쓴 값을 믿지 않는다. 도구가 받아 둔 것만 응답에 싣고, 도구
 * 결과에 없던 contentid 를 고른 줄은 통째로 버린다 (FR-AG-003).
 *
 * ## 남기지 않는 것
 *
 * 제안 · 이유와 도구 결과는 저장하지 않고 로그에도 남기지 않는다. 응답으로만 흐른다
 * (FR-AG-004 · DB 명세서 6-4).
 */

const SEARCH_TOOL = 'search_places';
const DETAIL_TOOL = 'place_detail';

/** 검색 한 번에 받아 볼 곳 수. 모델이 종류 · 거리로 고를 만큼만 준다 */
export const SUGGEST_SEARCH_ROWS = 8;
/** 응답에 싣는 다른 후보 수 (API 4-11) */
export const SUGGEST_MAX_ALTERNATIVES = 3;
/** 줄마다 공사 0 – 2콜 (FR-AG-010) */
export const SUGGEST_TOOL_CALLS_PER_ITEM = 2;
/** 이유 한 줄. 길면 자른다 — 화면은 한 줄만 보인다 */
export const SUGGEST_REASON_MAX = 200;

const BUDGET_MESSAGE =
  '오늘 쓸 수 있는 관광정보 조회를 모두 썼습니다. 내일 0시부터 다시 볼 수 있고, 일정 입력과 저장은 지금도 할 수 있습니다.';

const NO_NAME_REASON = '장소 이름이 없는 줄이라 찾지 않았어요. 장소 찾기로 직접 고르거나 직접 정한 곳으로 두세요.';

/**
 * 장소 이름이 아닌 낱말. 이 낱말로만 된 줄("점심" · "숙소 체크인")은 **검색하지 않는다** —
 * 비슷한 곳을 억지로 붙이면 사람이 고른 것처럼 보인다 (FR-AG-011).
 */
const GENERIC_WORDS: readonly string[] = [
  '조식', '중식', '석식', '아침', '점심', '저녁', '식사', '간식', '브런치', '커피', '카페', '맛집',
  '숙소', '숙박', '호텔', '펜션', '체크인', '체크아웃', '입실', '퇴실', '취침', '기상',
  '휴식', '자유시간', '자유일정', '자유', '쇼핑', '관광', '일정', '미정',
  '이동', '출발', '도착', '집결', '해산', '귀가', '버스', '차량',
];

const SYSTEM = [
  '너는 여행 상품 일정에서 아직 장소를 고르지 않은 줄에 맞는 관광지를 찾아 주는 도우미다.',
  `줄마다 문구에서 장소 이름을 뽑아 ${SEARCH_TOOL} 로 찾는다. 검색 지역은 서버가 상품 지역으로 고정하므로 지역을 입력하지 않는다.`,
  '결과가 없으면 검색어를 한 번 더 바꿔 찾는다 — 「초당순두부 점심」이면 「초당순두부」처럼 장소 이름만 남긴다.',
  '여럿이면 줄의 종류, 앞뒤 고른 줄과의 거리, 이름이 얼마나 맞는지로 하나를 고른다. 고를 수 없으면 NOT_FOUND 로 둔다 — 비슷한 곳을 억지로 붙이지 않는다.',
  `분류나 주소를 확인해야 하면 ${DETAIL_TOOL} 을 부른다. 줄마다 도구는 두 번까지다.`,
  'contentId 는 도구 결과에 있던 값만 쓴다. 기억나는 번호를 쓰지 않는다.',
  'reason 은 왜 그곳인지 한 줄로만 쓴다. 판정 · 등급 · 규칙 번호 · 통과 여부를 쓰지 않는다.',
].join('\n');

const RESULT_SCHEMA = {
  type: 'object' as const,
  properties: {
    items: {
      type: 'array',
      description: '줄마다 하나씩. 요청한 줄만 넣는다',
      items: {
        type: 'object',
        properties: {
          itemId: { type: 'integer' },
          kind: { type: 'string', enum: ['FOUND', 'NOT_FOUND', 'NO_NAME'] },
          contentId: { type: ['string', 'null'], description: 'FOUND 일 때 고른 곳. 도구 결과에 있던 값만' },
          alternativeContentIds: { type: 'array', items: { type: 'string' }, description: '다른 후보 (최대 3)' },
          reason: { type: 'string' },
        },
        required: ['itemId', 'kind', 'reason'],
      },
    },
  },
  required: ['items'],
};

export interface PlaceSuggestionOptions {
  readonly items: PlanItemRepository;
  readonly kto: () => KtoClient;
  /** 만들 때 던질 수 있다 — 모델이 설정되지 않았으면 거절하지 않고 `incomplete` 로 끝낸다 */
  readonly llm: () => LlmClient;
  readonly budget: PlanBudget;
  readonly lock: AgentLock;
  readonly timeoutMs?: number;
  readonly clock?: () => number;
}

export interface PlaceSuggestionResult {
  readonly items: readonly PlaceSuggestion[];
  readonly summary: { readonly found: number; readonly notFound: number; readonly noName: number };
  readonly incomplete: AgentIncomplete | null;
}

/** 도구가 받아 둔 곳. 응답의 제목 · 주소는 여기서만 나온다 */
interface FoundPlace {
  readonly contentId: string;
  readonly contentTypeId: number;
  readonly title: string;
  readonly kindName: string;
  readonly addr: string | null;
  readonly distanceM: number | null;
}

export class PlaceSuggestionService {
  private readonly items: PlanItemRepository;
  private readonly kto: () => KtoClient;
  private readonly llm: () => LlmClient;
  private readonly budget: PlanBudget;
  private readonly lock: AgentLock;
  private readonly timeoutMs: number | undefined;
  private readonly clock: (() => number) | undefined;

  constructor(options: PlaceSuggestionOptions) {
    this.items = options.items;
    this.kto = options.kto;
    this.llm = options.llm;
    this.budget = options.budget;
    this.lock = options.lock;
    this.timeoutMs = options.timeoutMs;
    this.clock = options.clock;
  }

  /**
   * 고르지 않은 줄의 장소 제안. `itemIds` 가 없으면 그 상품의 PENDING 전부다.
   *
   * 실행 전에만 거절한다 — 남의 상품은 404, 예산 100% 는 429, 같은 에이전트가 도는 중이면 429.
   * 실행한 뒤의 실패 · 시간 초과는 끝난 줄만 싣고 `incomplete` 로 알린다 (EX-AG-001 · 002).
   */
  async suggest(accountId: number, productId: number, itemIds: readonly number[] | null): Promise<PlaceSuggestionResult> {
    const product = await this.items.product(accountId, productId);
    if (product === null) {
      throw new DomainException(
        HttpStatus.NOT_FOUND, 'NOT_FOUND', '상품을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.',
      );
    }

    const targets = product.items.filter((item) =>
      item.matchStatus === 'PENDING' && (itemIds === null || itemIds.includes(item.id)));
    const searchable = targets.filter((item) => hasPlaceName(item.placeLabel));
    const noName = targets.filter((item) => !hasPlaceName(item.placeLabel)).map(toNoName);

    // 찾을 이름이 하나도 없으면 모델도 공사도 부르지 않는다
    if (searchable.length === 0) return done(noName, null);

    const decision = await this.budget('KOR');
    if (!decision.allowed) {
      throw new DomainException(HttpStatus.TOO_MANY_REQUESTS, 'BUDGET_EXHAUSTED', BUDGET_MESSAGE, 'REQUEST');
    }

    return this.lock.runExclusive(accountId, 'PLACE_MATCH', async () =>
      this.run(product, searchable, noName));
  }

  private async run(
    product: PlanProduct,
    searchable: readonly PlanItem[],
    noName: readonly PlaceSuggestion[],
  ): Promise<PlaceSuggestionResult> {
    let runner: AgentRunner;
    try {
      runner = new AgentRunner(this.llm(), this.clock);
    } catch {
      // 모델을 못 쓰는 것은 실행 전 거절 사유가 아니다. 사람이 하는 길은 그대로 열려 있다 (FR-AG-005)
      return done(noName, { reasonCode: 'LLM_UNAVAILABLE', itemIds: searchable.map((i) => i.id) });
    }

    const catalog = new Map<string, FoundPlace>();
    const run = await runner.run({
      purpose: 'PLACE_MATCH',
      system: SYSTEM,
      input: describeLines(product, searchable),
      tools: [this.searchTool(product, searchable, catalog), this.detailTool(catalog)],
      resultSchema: RESULT_SCHEMA,
      maxToolCalls: SUGGEST_TOOL_CALLS_PER_ITEM * searchable.length,
      ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
    });

    const byId = new Map(searchable.map((item) => [item.id, item]));
    const kept: PlaceSuggestion[] = [];
    const answers = readAnswers(run.result);
    for (const answer of answers) {
      // 요청하지 않은 줄과 두 번 나온 줄은 버린다
      if (!byId.has(answer.itemId) || kept.some((k) => k.itemId === answer.itemId)) continue;
      const suggestion = toSuggestion(answer, catalog, run.evidence);
      if (suggestion !== null) kept.push(suggestion);
    }
    runner.report(run, answers.length - kept.length);

    const missing = searchable.filter((item) => !kept.some((k) => k.itemId === item.id)).map((i) => i.id);
    const order = new Map(product.items.map((item, index) => [item.id, index]));
    const items = [...kept, ...noName].sort((a, b) => (order.get(a.itemId) ?? 0) - (order.get(b.itemId) ?? 0));
    return done(
      items,
      missing.length === 0
        ? null
        : { reasonCode: run.stopped === null ? 'LLM_UNAVAILABLE' : incompleteReason(run.stopped), itemIds: missing },
    );
  }

  /** 상품 지역 안에서 찾는다. 지역은 모델 입력이 아니라 서버가 붙인다 (FR-AG-010) */
  private searchTool(
    product: PlanProduct,
    searchable: readonly PlanItem[],
    catalog: Map<string, FoundPlace>,
  ): AgentTool {
    return {
      spec: {
        name: SEARCH_TOOL,
        description: '상품 지역 안에서 이름으로 관광지를 찾는다. 지역은 서버가 붙이므로 넣지 않는다.',
        inputSchema: {
          type: 'object',
          properties: {
            itemId: { type: 'integer', description: '어느 줄을 위한 검색인지. 앞뒤 고른 줄과의 거리를 함께 준다' },
            keyword: { type: 'string', description: '장소 이름만. 「점심」 같은 낱말은 빼고 넣는다' },
            contentTypeId: { type: 'integer', description: '12 관광지 · 14 문화시설 · 15 행사 · 28 레포츠 · 32 숙박 · 38 쇼핑 · 39 음식점' },
          },
          required: ['itemId', 'keyword'],
        },
      },
      run: async (input: unknown, evidence: AgentEvidence): Promise<string> => {
        const { itemId, keyword, contentTypeId } = readSearchInput(input);
        if (keyword === null) return '검색어가 비어 있다. 장소 이름을 넣는다.';
        await this.assertBudget();

        const anchor = anchorOf(product.items, searchable.find((item) => item.id === itemId) ?? null);
        let page: KtoListPage;
        try {
          page = await this.kto().searchKeyword({
            keyword,
            ...(contentTypeId === null ? {} : { contentTypeId }),
            ...(product.regnCd === null ? {} : { lDongRegnCd: product.regnCd }),
            ...(product.signguCd === null ? {} : { lDongSignguCd: product.signguCd }),
            numOfRows: SUGGEST_SEARCH_ROWS,
          });
        } catch (e) {
          if (!isKtoError(e)) throw e;
          return '조회에 실패했다. 검색어를 바꾸거나 이 줄은 NOT_FOUND 로 둔다.';
        }

        const places = visibleItems(page).map((item) => toFound(item, anchor)).filter((p) => p.contentId !== '');
        for (const place of places) {
          evidence.add('contentId', place.contentId);
          catalog.set(place.contentId, place);
        }
        if (places.length === 0) return '찾은 곳이 없다.';
        return JSON.stringify(places);
      },
    };
  }

  /** 분류 · 주소 확인. 앞선 검색에 나온 번호만 본다 — 모르는 번호를 조회로 만들어 주지 않는다 */
  private detailTool(catalog: Map<string, FoundPlace>): AgentTool {
    return {
      spec: {
        name: DETAIL_TOOL,
        description: '검색으로 찾은 곳의 분류 · 주소를 확인한다.',
        inputSchema: {
          type: 'object',
          properties: { contentId: { type: 'string' } },
          required: ['contentId'],
        },
      },
      run: async (input: unknown, evidence: AgentEvidence): Promise<string> => {
        const contentId = readContentId(input);
        if (contentId === null || !evidence.has('contentId', contentId)) {
          return `${SEARCH_TOOL} 결과에 없던 번호다. 먼저 찾는다.`;
        }
        await this.assertBudget();

        let item: Record<string, unknown>;
        try {
          item = await this.kto().detailCommon(contentId);
        } catch (e) {
          if (!isKtoError(e)) throw e;
          return '조회에 실패했다. 검색 결과의 값으로 정한다.';
        }
        if (String(item.showflag ?? '') === '0') {
          // 비표출은 화면에 없는 곳이다. 목록에서 지워 고를 수 없게 한다 (FR-PL-019)
          catalog.delete(contentId);
          return '지금은 보이지 않는 곳이다. 다른 곳을 고른다.';
        }

        const before = catalog.get(contentId);
        const merged = {
          contentId,
          contentTypeId: numberOr(item.contenttypeid, before?.contentTypeId ?? 0),
          title: text(item.title) ?? before?.title ?? '',
          kindName: kindNameOf(item.lclsSystm2) ?? before?.kindName ?? '',
          addr: text(item.addr1) ?? before?.addr ?? null,
          distanceM: before?.distanceM ?? null,
        };
        catalog.set(contentId, merged);
        return JSON.stringify(merged);
      },
    };
  }

  /** 도구의 공사 호출도 검수와 같은 100% 게이트를 지난다 (EI-CM-012) */
  private async assertBudget(): Promise<void> {
    const decision = await this.budget('KOR');
    if (!decision.allowed) throw new BudgetBlockedError(decision);
  }
}

/**
 * 그 줄에 찾을 장소 이름이 있는가.
 *
 * 일반 낱말로만 된 줄은 이름이 없는 것으로 본다. 모델에게 보내지 않으므로 도구 호출도 0 이다.
 */
export function hasPlaceName(label: string | null): boolean {
  const raw = (label ?? '').trim();
  if (raw === '') return false;
  const words = raw.split(/[\s,·/()[\]-]+/).filter((w) => w !== '');
  return words.some((word) => !GENERIC_WORDS.includes(word));
}

/** 앞뒤 고른 줄 중 좌표가 있는 곳. 검색 결과와의 거리를 재는 기준이다 (FR-AG-010) */
export function anchorOf(items: readonly PlanItem[], item: PlanItem | null): { mapx: number; mapy: number } | null {
  if (item === null) return null;
  const sameDay = items.filter((i) => i.dayNo === item.dayNo && i.matchStatus === 'CONFIRMED'
    && i.mapx !== null && i.mapy !== null);
  const before = sameDay.filter((i) => i.seq < item.seq);
  const near = before[before.length - 1] ?? sameDay.find((i) => i.seq > item.seq) ?? null;
  return near === null || near.mapx === null || near.mapy === null ? null : { mapx: near.mapx, mapy: near.mapy };
}

/** 직선거리(m). 이동시간이 아니다 — 시간은 길찾기만 말할 수 있다 (R08 과 같은 원칙) */
export function straightDistanceM(
  from: { mapx: number; mapy: number } | null,
  to: { mapx: number; mapy: number } | null,
): number | null {
  if (from === null || to === null) return null;
  const rad = Math.PI / 180;
  const meanLat = ((from.mapy + to.mapy) / 2) * rad;
  const dx = (to.mapx - from.mapx) * rad * Math.cos(meanLat);
  const dy = (to.mapy - from.mapy) * rad;
  return Math.round(Math.sqrt(dx * dx + dy * dy) * 6_371_000);
}

interface Answer {
  readonly itemId: number;
  readonly kind: PlaceSuggestion['kind'];
  readonly contentId: string | null;
  readonly alternativeContentIds: readonly string[];
  readonly reason: string;
}

/** 모델의 답 모양 읽기. 모양이 아니면 그 줄만 버린다 — 던지지 않는다 */
function readAnswers(result: unknown): readonly Answer[] {
  const raw = (result as { items?: unknown } | null)?.items;
  if (!Array.isArray(raw)) return [];
  const answers: Answer[] = [];
  for (const entry of raw) {
    const row = entry as Record<string, unknown>;
    const itemId = Number(row.itemId);
    const kind = String(row.kind ?? '');
    if (!Number.isInteger(itemId) || (kind !== 'FOUND' && kind !== 'NOT_FOUND' && kind !== 'NO_NAME')) continue;
    answers.push({
      itemId,
      kind,
      contentId: text(row.contentId),
      alternativeContentIds: Array.isArray(row.alternativeContentIds)
        ? row.alternativeContentIds.map((v) => text(v)).filter((v): v is string => v !== null)
        : [],
      reason: (text(row.reason) ?? '').slice(0, SUGGEST_REASON_MAX),
    });
  }
  return answers;
}

/**
 * 답 한 줄 → 응답 항목. 도구 결과에 없던 곳을 고른 줄은 `null` 이다 — 그 줄째 버린다
 * (FR-AG-003 · EX-AG-003).
 */
function toSuggestion(
  answer: Answer,
  catalog: ReadonlyMap<string, FoundPlace>,
  evidence: AgentEvidence,
): PlaceSuggestion | null {
  const known = (contentId: string | null): FoundPlace | null =>
    contentId !== null && evidence.has('contentId', contentId) ? catalog.get(contentId) ?? null : null;

  const place = answer.kind === 'FOUND' ? known(answer.contentId) : null;
  if (answer.kind === 'FOUND' && place === null) return null;

  // 모델이 같은 곳을 두 번 낼 수 있다 — 한 번씩만 남기고 셋을 자른다. 겹치면 카드에 같은 곳이 두 번 나온다 (UI-S2-044)
  const alternatives = [...new Set(answer.alternativeContentIds)]
    .filter((id) => id !== place?.contentId)
    .map((id) => known(id))
    .filter((p): p is FoundPlace => p !== null)
    .slice(0, SUGGEST_MAX_ALTERNATIVES)
    .map((p) => ({ contentId: p.contentId, title: p.title, kindName: p.kindName, distanceM: p.distanceM }));

  return {
    itemId: answer.itemId,
    kind: answer.kind,
    place: place === null ? null : {
      contentId: place.contentId,
      contentTypeId: place.contentTypeId,
      title: place.title,
      kindName: place.kindName,
      addr: place.addr,
    },
    alternatives,
    reason: answer.reason,
  };
}

/** 모델에게 주는 줄 목록. 상품 자기 일정만 담는다 (EI-LM-009) */
function describeLines(product: PlanProduct, searchable: readonly PlanItem[]): string {
  const lines = searchable.map((item) => {
    const around = neighbours(product.items, item);
    const context = around === '' ? '' : ` · ${around}`;
    return `줄 ${item.id} · ${item.dayNo}일차 ${item.startTime} · ${itemTypeName(item.itemType)} · 문구 "${item.placeLabel ?? ''}"${context}`;
  });
  return [`아래 ${searchable.length}줄의 장소를 찾아라. 요청한 줄만 답한다.`, ...lines].join('\n');
}

function neighbours(items: readonly PlanItem[], item: PlanItem): string {
  const sameDay = items.filter((i) => i.dayNo === item.dayNo && i.matchStatus === 'CONFIRMED' && i.placeLabel !== null);
  const before = sameDay.filter((i) => i.seq < item.seq).slice(-1)[0];
  const after = sameDay.find((i) => i.seq > item.seq);
  return [
    before === undefined ? '' : `앞 ${before.placeLabel}`,
    after === undefined ? '' : `뒤 ${after.placeLabel}`,
  ].filter((s) => s !== '').join(' · ');
}

function itemTypeName(itemType: string): string {
  const names: Record<string, string> = {
    SIGHT: '관광', MEAL: '식사', LODGING: '숙박', REST: '휴식', MOVE: '이동', FREE: '자유',
  };
  return names[itemType] ?? itemType;
}

function toNoName(item: PlanItem): PlaceSuggestion {
  return { itemId: item.id, kind: 'NO_NAME', place: null, alternatives: [], reason: NO_NAME_REASON };
}

function done(items: readonly PlaceSuggestion[], incomplete: AgentIncomplete | null): PlaceSuggestionResult {
  return {
    items,
    summary: {
      found: items.filter((i) => i.kind === 'FOUND').length,
      notFound: items.filter((i) => i.kind === 'NOT_FOUND').length,
      noName: items.filter((i) => i.kind === 'NO_NAME').length,
    },
    incomplete,
  };
}

function toFound(item: Record<string, unknown>, anchor: { mapx: number; mapy: number } | null): FoundPlace {
  const mapx = numberOrNull(item.mapx);
  const mapy = numberOrNull(item.mapy);
  return {
    contentId: String(item.contentid ?? ''),
    contentTypeId: numberOr(item.contenttypeid, 0),
    title: String(item.title ?? ''),
    kindName: kindNameOf(item.lclsSystm2) ?? '',
    addr: text(item.addr1),
    distanceM: straightDistanceM(anchor, mapx === null || mapy === null ? null : { mapx, mapy }),
  };
}

/** 비표출(`showflag` 0)은 뺀다. 값이 없으면 표출로 본다 (FR-PL-019) */
function visibleItems(page: KtoListPage): readonly Record<string, unknown>[] {
  return page.items.filter((item) => item.showflag === undefined || String(item.showflag) !== '0');
}

function readSearchInput(input: unknown): { itemId: number; keyword: string | null; contentTypeId: ContentTypeId | null } {
  const row = (input ?? {}) as Record<string, unknown>;
  const itemId = Number(row.itemId);
  const contentTypeId = Number(row.contentTypeId);
  return {
    itemId: Number.isInteger(itemId) ? itemId : 0,
    keyword: text(row.keyword),
    // 모르는 유형은 조건에서 뺀다 — 공사가 파라미터 오류로 돌려준다
    contentTypeId: (CONTENT_TYPE_ID as readonly number[]).includes(contentTypeId) ? contentTypeId as ContentTypeId : null,
  };
}

function readContentId(input: unknown): string | null {
  return text((input as Record<string, unknown> | null)?.contentId);
}

function kindNameOf(lcls2: unknown): string | null {
  const code = text(lcls2);
  return code === null ? null : LCLS_SYSTM2[code]?.name ?? null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function numberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n !== 0 ? n : null;
}
