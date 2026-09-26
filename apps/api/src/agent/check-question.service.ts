import { HttpStatus } from '@nestjs/common';
import type { AgentIncomplete, CheckQuestionPlace, ContentTypeId } from '@tourlint/shared';
import { CONTENT_TYPE_ID, INTRO_FIELDS, findingMessage } from '@tourlint/shared';
import { DomainException } from '../common/domain.exception';
import type { ItineraryItemRow, ProductRow } from '../audit/audit-runner';
import { addDays, formatIsoDate, parseIsoDate } from '../engine/calendar/dates';
import { BudgetBlockedError } from '../external/budget-guard';
import { isKtoError, type KtoClient } from '../external/kto';
import type { LlmClient } from '../external/llm';
import type { StoredAuditRun } from '../persistence/audit-result.repository';
import { PlanCache } from '../plan/plan-cache';
import type { PlanBudget } from '../plan/plan.service';
import { AgentRunner, incompleteReason, type AgentTool } from './agent-runner';
import type { AgentEvidence } from './agent-evidence';
import type { AgentLock } from './agent-lock';

/**
 * 검수 에이전트 — 직접 확인할 곳에 전화로 물어볼 내용 (FR-AG-020 ~ 022 · API 4-11).
 *
 * 확인 필요 목록을 **곳마다** 묶어 방문 날짜 · 시각과 문의처, 물어볼 질문 두세 개를 낸다.
 * 판정하지 않는다 — \[확인했어요\]는 사람이 누르고 점수는 그대로다 (FR-AG-022).
 *
 * ## 서버가 정하는 것
 *
 * 방문 날짜 · 시각은 항목 값 그대로다. 모델이 쓴 날짜를 쓰지 않는다 — 잘못된 날로 전화하면
 * 「그날은 엽니다」라는 답을 듣고 못 간다.
 *
 * 전화번호는 도구가 받아 온 번호만 싣는다. 모델이 지어낸 번호는 `null` 로 바꾸고 화면이
 * "등록된 전화번호가 없어요" 를 적는다 (EX-AG-003 · 005).
 *
 * ## 남기지 않는 것
 *
 * 질문 · 문의처와 도구 결과는 저장하지 않고 로그에도 남기지 않는다 (FR-AG-004).
 */

const PLACES_TOOL = 'unverified_places';
const CONTACT_TOOL = 'place_contact';

/** 곳마다 질문 두세 개 (FR-AG-020) */
export const CHECK_MAX_QUESTIONS = 3;
/** 질문 한 줄. 길면 자른다 */
export const CHECK_QUESTION_MAX = 120;
/** 곳마다 문의처 조회 최대 2콜 — 공통정보 `tel` 이 비었을 때만 소개정보를 본다 */
export const CHECK_TOOL_CALLS_PER_PLACE = 2;

const BUDGET_MESSAGE =
  '오늘 쓸 수 있는 관광정보 조회를 모두 썼습니다. 내일 0시부터 다시 볼 수 있고, 확인 필요 목록은 지금도 볼 수 있습니다.';

const SYSTEM = [
  '너는 여행 상품의 확인 필요 목록을 보고 전화로 무엇을 물어볼지 정리해 주는 도우미다.',
  `${PLACES_TOOL} 로 곳 목록과 확인이 필요한 이유를 받는다. 곳마다 ${CONTACT_TOOL} 로 문의처를 확인한다.`,
  '질문은 곳마다 두세 개다. 그 곳의 확인 필요 사유에서 나오는 것만 묻는다 — 방문 날짜 · 시각을 말하고 그날 문을 여는지, 몇 시까지 하는지처럼 전화로 답을 들을 수 있는 것을 쓴다.',
  '전화번호는 도구 결과에 있던 번호만 쓴다. 없으면 tel 을 null 로 둔다 — 지어내거나 다른 곳의 번호를 쓰지 않는다.',
  '판정하지 않는다. 등급 · 점수 · 규칙 번호를 쓰지 않고, 무시하라거나 확인했다고 적지 않는다.',
].join('\n');

const RESULT_SCHEMA = {
  type: 'object' as const,
  properties: {
    places: {
      type: 'array',
      description: '곳마다 하나씩. 도구가 준 곳만 넣는다',
      items: {
        type: 'object',
        properties: {
          itemId: { type: 'integer' },
          findingIds: { type: 'array', items: { type: 'integer' }, description: '그 질문이 향하는 확인 필요 항목' },
          tel: { type: ['string', 'null'], description: '도구 결과에 있던 번호만' },
          questions: { type: 'array', items: { type: 'string' }, description: '두세 개' },
        },
        required: ['itemId', 'questions'],
      },
    },
  },
  required: ['places'],
};

/** 에이전트가 읽는 검수 결과. `AuditService` 가 그대로 만족한다 — 쓰기 메서드는 넘기지 않는다 */
export interface CheckQuestionSource {
  assertOwns(kind: 'run', id: number, accountId: number): Promise<void>;
  getRun(auditRunId: number): Promise<StoredAuditRun>;
  itemsOf(productId: number): Promise<readonly ItineraryItemRow[]>;
  productOf(productId: number): Promise<ProductRow | null>;
  /**
   * 항목의 표시 이름 — 결과 화면과 같은 값이다 (#606). 이름을 저장하지 않은 곳(장소 담기 · 등록 화면에서
   * 고른 곳)은 여기서만 이름을 얻는다. 없으면 저장된 이름만 쓴다
   */
  displayLabels?(items: readonly ItineraryItemRow[]): Promise<ReadonlyMap<number, string>>;
}

export interface CheckQuestionOptions {
  readonly audit: CheckQuestionSource;
  readonly kto: () => KtoClient;
  readonly llm: () => LlmClient;
  readonly budget: PlanBudget;
  readonly lock: AgentLock;
  readonly cache?: PlanCache;
  readonly timeoutMs?: number;
  readonly clock?: () => number;
}

export interface CheckQuestionResult {
  readonly places: readonly CheckQuestionPlace[];
  readonly incomplete: AgentIncomplete | null;
}

/** 확인이 필요한 곳 하나 — finding 여럿이 같은 항목을 가리킨다 */
interface UnverifiedPlace {
  readonly itemId: number;
  readonly placeLabel: string;
  readonly contentId: string | null;
  readonly contentTypeId: number | null;
  readonly visit: { dayNo: number; date: string; start: string | null };
  readonly findingIds: readonly number[];
  readonly reasons: readonly string[];
}

export class CheckQuestionService {
  private readonly audit: CheckQuestionSource;
  private readonly kto: () => KtoClient;
  private readonly llm: () => LlmClient;
  private readonly budget: PlanBudget;
  private readonly lock: AgentLock;
  private readonly cache: PlanCache;
  private readonly timeoutMs: number | undefined;
  private readonly clock: (() => number) | undefined;

  constructor(options: CheckQuestionOptions) {
    this.audit = options.audit;
    this.kto = options.kto;
    this.llm = options.llm;
    this.budget = options.budget;
    this.lock = options.lock;
    this.cache = options.cache ?? new PlanCache();
    this.timeoutMs = options.timeoutMs;
    this.clock = options.clock;
  }

  /**
   * 그 검수 실행의 확인 필요 목록 → 곳마다 전화로 물어볼 내용.
   *
   * 남의 실행은 404 다. 확인할 곳이 없으면 모델도 공사도 부르지 않는다.
   */
  async questions(accountId: number, runId: number): Promise<CheckQuestionResult> {
    await this.audit.assertOwns('run', runId, accountId);
    const run = await this.audit.getRun(runId);
    const [items, product] = await Promise.all([
      this.audit.itemsOf(run.productId),
      this.audit.productOf(run.productId),
    ]);
    const places = unverifiedPlaces(run, items, product);
    if (places.length === 0) return { places: [], incomplete: null };

    const decision = await this.budget('KOR');
    if (!decision.allowed) {
      throw new DomainException(HttpStatus.TOO_MANY_REQUESTS, 'BUDGET_EXHAUSTED', BUDGET_MESSAGE, 'REQUEST');
    }

    /*
     * 이름을 저장하지 않은 곳도 모델이 이름과 온전한 이유 문장을 보게 한다 (#908). 결과 화면이 방금
     * 읽은 이름이 10분 캐시에 있다 — 없으면 그 곳만 공통정보로 찾는다
     */
    const labels = this.audit.displayLabels === undefined ? new Map<number, string>() : await this.audit.displayLabels(items);
    const named = labels.size === 0 ? places : unverifiedPlaces(run, items, product, labels);
    return this.lock.runExclusive(accountId, 'CHECK_QUESTIONS', async () => this.run(named));
  }

  private async run(places: readonly UnverifiedPlace[]): Promise<CheckQuestionResult> {
    let runner: AgentRunner;
    try {
      runner = new AgentRunner(this.llm(), this.clock);
    } catch {
      return { places: [], incomplete: { reasonCode: 'LLM_UNAVAILABLE', itemIds: places.map((p) => p.itemId) } };
    }

    const run = await runner.run({
      purpose: 'CHECK_QUESTIONS',
      system: SYSTEM,
      input: describePlaces(places),
      tools: [placesTool(places), this.contactTool(places)],
      resultSchema: RESULT_SCHEMA,
      maxToolCalls: 1 + CHECK_TOOL_CALLS_PER_PLACE * places.length,
      ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
    });

    const byId = new Map(places.map((place) => [place.itemId, place]));
    const kept: CheckQuestionPlace[] = [];
    const answers = readAnswers(run.result);
    for (const answer of answers) {
      const place = byId.get(answer.itemId);
      // 도구가 주지 않은 곳과 두 번 나온 곳은 버린다
      if (place === undefined || kept.some((k) => k.itemId === answer.itemId)) continue;
      if (answer.questions.length === 0) continue;
      kept.push({
        findingIds: keepFindingIds(answer.findingIds, place),
        itemId: place.itemId,
        // 날짜 · 시각은 항목 값 그대로다. 모델이 쓴 값을 쓰지 않는다
        visit: place.visit,
        tel: run.evidence.phoneOrNull(answer.tel),
        questions: [...answer.questions],
      });
    }
    runner.report(run, answers.length - kept.length);

    const missing = places.filter((p) => !kept.some((k) => k.itemId === p.itemId)).map((p) => p.itemId);
    return {
      places: kept,
      incomplete: missing.length === 0
        ? null
        : { reasonCode: run.stopped === null ? 'LLM_UNAVAILABLE' : incompleteReason(run.stopped), itemIds: missing },
    };
  }

  /**
   * 문의처 (FR-AU-017 과 같은 순서를 거꾸로 — 공통정보 `tel` 이 먼저다).
   *
   * `tel` 이 비었을 때만 소개정보의 `infocenter` 계열을 본다. 곳마다 최대 2콜이고 10분 캐시가
   * 받아 준다. 받은 번호만 증거로 적는다 (EX-AG-003).
   */
  private contactTool(places: readonly UnverifiedPlace[]): AgentTool {
    return {
      spec: {
        name: CONTACT_TOOL,
        description: '그 곳의 문의처를 확인한다. 없으면 null 이다.',
        inputSchema: { type: 'object', properties: { itemId: { type: 'integer' } }, required: ['itemId'] },
      },
      run: async (input: unknown, evidence: AgentEvidence): Promise<string> => {
        const itemId = Number((input as Record<string, unknown> | null)?.itemId);
        const place = places.find((p) => p.itemId === itemId);
        if (place === undefined) return '그 곳은 확인 필요 목록에 없다.';
        if (place.contentId === null) {
          return '직접 정한 곳이라 등록된 문의처가 없다. tel 은 null 로 둔다.';
        }

        const tel = await this.cache.getOrLoad(`tel:${place.contentId}:${String(place.contentTypeId)}`, async () =>
          this.contactOf(place.contentId ?? '', place.contentTypeId));
        if (tel === null) return JSON.stringify({ itemId, tel: null });
        evidence.add('phone', tel);
        return JSON.stringify({ itemId, tel });
      },
    };
  }

  private async contactOf(contentId: string, contentTypeId: number | null): Promise<string | null> {
    await this.assertBudget();
    const common = await this.detail(() => this.kto().detailCommon(contentId));
    const tel = text(common?.tel);
    if (tel !== null) return tel;

    // 공통정보의 tel 이 비고 소개정보의 infocenter 에만 있는 콘텐츠가 있다 (content-view 실측)
    if (contentTypeId === null || !(CONTENT_TYPE_ID as readonly number[]).includes(contentTypeId)) return null;
    await this.assertBudget();
    const intro = await this.detail(() => this.kto().detailIntro(contentId, contentTypeId as ContentTypeId));
    return intro === null ? null : text(intro[INTRO_FIELDS[contentTypeId as ContentTypeId].contact]);
  }

  private async detail(call: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown> | null> {
    try {
      return await call();
    } catch (e) {
      if (!isKtoError(e)) throw e;
      return null;
    }
  }

  private async assertBudget(): Promise<void> {
    const decision = await this.budget('KOR');
    if (!decision.allowed) throw new BudgetBlockedError(decision);
  }
}

/**
 * 확인 필요 목록을 곳마다 묶는다 (FR-AU-008 과 같은 거르개).
 *
 * 항목을 가리키지 않는 finding 은 곳이 없어 전화할 데도 없다 — 넣지 않는다.
 */
export function unverifiedPlaces(
  run: StoredAuditRun,
  items: readonly ItineraryItemRow[],
  product: ProductRow | null,
  /** 표시 이름 (`displayLabels`). 없으면 저장된 이름이다 */
  labels: ReadonlyMap<number, string> = new Map(),
): readonly UnverifiedPlace[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const nameOf = (id: number | null): string | null => {
    if (id === null) return null;
    return labels.get(id) ?? (byId.get(id)?.placeLabel || null);
  };
  const start = product === null ? null : parseIsoDate(product.startDate);
  const places = new Map<number, UnverifiedPlace>();

  for (const finding of run.findings) {
    if (finding.severity !== 'UNVERIFIED' && !finding.needsConfirmation) continue;
    if (finding.confirmed) continue;
    const itemId = finding.targetItemId;
    const item = itemId === null ? undefined : byId.get(itemId);
    if (itemId === null || item === undefined) continue;

    const before = places.get(itemId);
    places.set(itemId, {
      itemId,
      placeLabel: nameOf(itemId) ?? '',
      contentId: item.ktoContentId,
      contentTypeId: item.contentTypeId,
      visit: {
        dayNo: item.dayNo,
        date: start === null ? '' : formatIsoDate(addDays(start, item.dayNo - 1)),
        start: item.startTime,
      },
      findingIds: [...(before?.findingIds ?? []), finding.id],
      // 결과 화면과 같은 문장이다 — 저장된 문장은 이름을 저장하지 않은 곳의 자리가 비어 있다 (#606 · #908)
      reasons: [...(before?.reasons ?? []), findingMessage(
        finding.ruleCode, finding.message, finding.evidence, labels, nameOf(itemId), nameOf(finding.targetItemId2),
      )],
    });
  }
  return [...places.values()].sort((a, b) => a.visit.dayNo - b.visit.dayNo || a.itemId - b.itemId);
}

/** 곳 목록 도구 — 공사를 부르지 않는다 (0콜). 확인 필요 항목 번호를 증거로 적는다 */
function placesTool(places: readonly UnverifiedPlace[]): AgentTool {
  return {
    spec: {
      name: PLACES_TOOL,
      description: '확인이 필요한 곳과 그 이유를 받는다.',
      inputSchema: { type: 'object', properties: {} },
    },
    run: async (_input: unknown, evidence: AgentEvidence): Promise<string> => {
      for (const place of places) {
        for (const findingId of place.findingIds) evidence.add('findingId', findingId);
      }
      return JSON.stringify(places.map((place) => ({
        itemId: place.itemId,
        place: place.placeLabel,
        visit: place.visit,
        findingIds: place.findingIds,
        reasons: place.reasons,
      })));
    },
  };
}

interface Answer {
  readonly itemId: number;
  readonly findingIds: readonly number[];
  readonly tel: string | null;
  readonly questions: readonly string[];
}

function readAnswers(result: unknown): readonly Answer[] {
  const raw = (result as { places?: unknown } | null)?.places;
  if (!Array.isArray(raw)) return [];
  const answers: Answer[] = [];
  for (const entry of raw) {
    const row = entry as Record<string, unknown>;
    const itemId = Number(row.itemId);
    if (!Number.isInteger(itemId)) continue;
    answers.push({
      itemId,
      findingIds: Array.isArray(row.findingIds)
        ? row.findingIds.map((v) => Number(v)).filter((v) => Number.isInteger(v))
        : [],
      tel: text(row.tel),
      questions: Array.isArray(row.questions)
        ? row.questions
          .map((v) => text(v)?.slice(0, CHECK_QUESTION_MAX) ?? null)
          .filter((v): v is string => v !== null)
          .slice(0, CHECK_MAX_QUESTIONS)
        : [],
    });
  }
  return answers;
}

/** 그 곳의 확인 필요 항목만 남긴다. 모델이 하나도 고르지 않으면 그 곳 전부를 가리킨다 */
function keepFindingIds(chosen: readonly number[], place: UnverifiedPlace): number[] {
  const kept = chosen.filter((id) => place.findingIds.includes(id));
  return kept.length === 0 ? [...place.findingIds] : kept;
}

/** 모델에게 주는 곳 목록. 상품 자기 검수 결과만 담는다 (EI-LM-009) */
function describePlaces(places: readonly UnverifiedPlace[]): string {
  const lines = places.map((place) =>
    `곳 ${place.itemId} · ${place.visit.dayNo}일차 ${place.visit.date} ${place.visit.start ?? ''} · ${place.placeLabel}\n`
    + place.reasons.map((reason) => `  - ${reason}`).join('\n'));
  return [`확인이 필요한 곳 ${places.length}곳이다. 곳마다 전화로 물어볼 것을 정리하라.`, ...lines].join('\n');
}

function text(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}
