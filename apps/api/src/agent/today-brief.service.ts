import { kstIso } from '@tourlint/shared';
import type { AgentIncomplete, TodayItem } from '@tourlint/shared';
import { kstToday } from '../batch/sync-window';
import type { LlmClient } from '../external/llm';
import type { BriefProduct, ChangeRow } from '../radar/radar.repository';
import { AgentRunner, incompleteReason, type AgentTool } from './agent-runner';
import type { AgentEvidence } from './agent-evidence';
import type { AgentLock } from './agent-lock';

/**
 * 레이더 에이전트 — 오늘 할 일 정리 (FR-AG-030 · 031 · API 4-11).
 *
 * **순서와 대상은 서버가 정한다.** 출발일이 가까운 상품의 바뀐 정보가 먼저고 관심 지역 새
 * 소식이 그다음이다. 모델은 후보마다 이유 한 줄과, 할 일이 없는 상품의 한 줄만 쓴다 —
 * 순서 · 개수 · 대상을 바꾸지 못한다.
 *
 * 공사를 부르지 않는다(0콜). 저장된 알림 · 신호와 상품 출발일만 읽는다.
 *
 * ## 하지 않는 것
 *
 * 재검수를 대신 돌리지 않고 기획 초안을 만들지 않는다. 할 일마다 사람이 누르는 기존 버튼이
 * 붙는다 — \[다시 검수\](이미 다시 검수했으면 \[검수 결과 보기\]) · \[이 지역으로 새 상품 기획\]
 * (FR-AG-031). 목록은 저장하지 않는다.
 */

const CANDIDATES_TOOL = 'today_candidates';

/** 한 번에 보는 변경 알림 수. 화면의 오늘 할 일은 상품 단위라 넉넉하면 된다 */
export const BRIEF_CHANGE_ROWS = 100;
/** 이유 · 한 줄 길이 상한 */
export const BRIEF_REASON_MAX = 160;

const SYSTEM = [
  '너는 여행 상품 담당자의 오늘 할 일을 한 줄씩 정리해 주는 도우미다.',
  `${CANDIDATES_TOOL} 로 할 일 후보와, 할 일이 없는 상품을 받는다.`,
  '후보마다 key 를 그대로 두고 reason 한 줄만 쓴다. 순서를 바꾸거나 후보를 더하거나 빼지 않는다.',
  '이유는 도구가 준 값으로만 쓴다. 판정 · 등급 · 점수 · 예측을 쓰지 않는다.',
  '할 일의 상품 이름 · 지역 이름 · 달은 화면이 줄 머리에 따로 적는다. reason 에 다시 쓰지 않는다.',
  'kind 가 CHANGE 면 담은 곳 changedCount 곳의 관광정보가 바뀐 것이다. changedPlaces 에 이름이 있으면 그 이름을 적는다.',
  'reauditedAfter 가 true 면 바뀐 뒤에 이미 다시 검수한 상품이다. 다시 검수하라고 쓰지 않고 「바뀐 뒤 다시 검수했습니다. 결과를 확인하세요」 처럼 쓴다.',
  'newPlaceCount 는 새로 등록된 곳의 수다. 바뀐 것이 아니므로 「바뀌었다」고 쓰지 않고 「새로 등록된 곳이 N곳 있습니다」 처럼 쓴다.',
  'kind 가 NEWS 면 관심 지역에 최근 새로 등록된 곳이 newPlaceCount 곳 있다는 뜻이다. 뉴스 · 기사 · 관측이라는 말로 바꾸지 않는다.',
  'matchedKeywords 가 있으면 관심 키워드와 맞는 곳이 있다고 덧붙인다.',
  '할 일이 없는 상품에는 상품 이름과 함께 바뀐 정보가 없다는 한 줄을 쓴다. newPlaceCount 가 있으면 새로 등록된 곳이 그만큼 있다고 덧붙인다.',
].join('\n');

const RESULT_SCHEMA = {
  type: 'object' as const,
  properties: {
    todos: {
      type: 'array',
      description: '후보마다 하나씩. key 는 도구가 준 값 그대로',
      items: {
        type: 'object',
        properties: { key: { type: 'string' }, reason: { type: 'string' } },
        required: ['key', 'reason'],
      },
    },
    quiet: {
      type: 'array',
      items: {
        type: 'object',
        properties: { productId: { type: 'integer' }, text: { type: 'string' } },
        required: ['productId', 'text'],
      },
    },
  },
  required: ['todos'],
};

/** 에이전트가 읽는 레이더. 저장된 것만 읽는다 — 공사 0콜 */
export interface TodayBriefSource {
  upcomingProducts(accountId: number, today: string): Promise<readonly BriefProduct[]>;
  changes(accountId: number, page: number, size: number): Promise<{ total: number; rows: readonly ChangeRow[] }>;
  regionSignals(accountId: number, now: Date): Promise<readonly Record<string, unknown>[]>;
  lastBatchAt(): Promise<Date | null>;
}

export interface TodayBriefOptions {
  readonly radar: TodayBriefSource;
  readonly llm: () => LlmClient;
  readonly lock: AgentLock;
  readonly timeoutMs?: number;
  readonly clock?: () => number;
}

export interface TodayBriefResult {
  /** 무엇을 기준으로 정리했는지 — 마지막 배치 시각, 없으면 지금 */
  readonly basisAt: string;
  readonly todos: readonly TodayItem[];
  readonly quiet: readonly { productId: number; text: string }[];
  readonly incomplete: AgentIncomplete | null;
}

/** 서버가 만든 할 일 후보. 순서 · 종류 · 대상이 여기서 정해진다 */
export interface BriefCandidate {
  readonly key: string;
  readonly kind: TodayItem['kind'];
  readonly productId: number | null;
  readonly region: TodayItem['region'];
  readonly action: TodayItem['action'];
  /** 모델에게 주는 사실. 이유는 이 값으로만 쓴다 */
  readonly facts: Record<string, unknown>;
}

export class TodayBriefService {
  private readonly radar: TodayBriefSource;
  private readonly llm: () => LlmClient;
  private readonly lock: AgentLock;
  private readonly timeoutMs: number | undefined;
  private readonly clock: (() => number) | undefined;

  constructor(options: TodayBriefOptions) {
    this.radar = options.radar;
    this.llm = options.llm;
    this.lock = options.lock;
    this.timeoutMs = options.timeoutMs;
    this.clock = options.clock;
  }

  /**
   * 오늘 할 일. 공사를 부르지 않아 예산 게이트가 없다 — 실행 전 거절은 동시 실행뿐이다.
   */
  async brief(accountId: number, now: Date = new Date()): Promise<TodayBriefResult> {
    const today = kstToday(now);
    const [products, changes, regions, lastBatchAt] = await Promise.all([
      this.radar.upcomingProducts(accountId, today),
      this.radar.changes(accountId, 0, BRIEF_CHANGE_ROWS),
      this.radar.regionSignals(accountId, now),
      this.radar.lastBatchAt(),
    ]);
    const basisAt = kstIso(lastBatchAt ?? now);
    const { candidates, quiet, newPlaces } = buildCandidates(products, changes.rows, regions);
    // 볼 상품도 관심 지역도 없으면 모델을 부르지 않는다
    if (candidates.length === 0 && quiet.length === 0) {
      return { basisAt, todos: [], quiet: [], incomplete: null };
    }

    return this.lock.runExclusive(accountId, 'TODAY_BRIEF', async () =>
      this.run(basisAt, candidates, quiet, newPlaces));
  }

  private async run(
    basisAt: string,
    candidates: readonly BriefCandidate[],
    quietProducts: readonly BriefProduct[],
    newPlaces: ReadonlyMap<number, number>,
  ): Promise<TodayBriefResult> {
    let runner: AgentRunner;
    try {
      runner = new AgentRunner(this.llm(), this.clock);
    } catch {
      return { basisAt, todos: [], quiet: [], incomplete: { reasonCode: 'LLM_UNAVAILABLE', itemIds: [] } };
    }

    const run = await runner.run({
      purpose: 'TODAY_BRIEF',
      system: SYSTEM,
      input: describe(candidates, quietProducts),
      tools: [candidatesTool(candidates, quietProducts, newPlaces)],
      resultSchema: RESULT_SCHEMA,
      // 도구는 후보 목록 하나뿐이다. 두 번 부를 일이 없다
      maxToolCalls: 2,
      ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
    });

    const answer = readAnswer(run.result);
    const reasons = new Map(answer.todos.map((t) => [t.key, t.reason]));
    // 순서는 서버가 만든 후보 순서다. 모델이 낸 순서를 쓰지 않는다
    const todos: TodayItem[] = [];
    for (const candidate of candidates) {
      const reason = reasons.get(candidate.key);
      if (reason === undefined || reason === '') continue;
      todos.push({
        kind: candidate.kind,
        productId: candidate.productId,
        region: candidate.region,
        reason,
        action: candidate.action,
      });
    }

    const quietIds = new Set(quietProducts.map((p) => p.productId));
    const quiet: { productId: number; text: string }[] = [];
    for (const line of answer.quiet) {
      // 도구가 준 상품만, 한 번씩 (FR-AG-003)
      if (!quietIds.has(line.productId) || !run.evidence.has('productId', line.productId)) continue;
      if (quiet.some((q) => q.productId === line.productId)) continue;
      quiet.push(line);
    }

    const dropped = (answer.todos.length - todos.length) + (answer.quiet.length - quiet.length);
    runner.report(run, Math.max(0, dropped));

    const unfinished = candidates.length - todos.length;
    return {
      basisAt,
      todos,
      quiet,
      incomplete: unfinished === 0
        ? null
        : { reasonCode: run.stopped === null ? 'LLM_UNAVAILABLE' : incompleteReason(run.stopped), itemIds: [] },
    };
  }
}

/**
 * 할 일 후보와 조용한 상품 (FR-AG-030).
 *
 * 순서는 **출발일이 가까운 상품의 바뀐 정보 → 관심 지역 새 소식**이다. 바뀐 정보가 없는
 * 상품은 할 일이 아니라 한 줄로 적을 대상이다 (FR-AG-031).
 */
export function buildCandidates(
  products: readonly BriefProduct[],
  changes: readonly ChangeRow[],
  regions: readonly Record<string, unknown>[],
): {
  candidates: readonly BriefCandidate[];
  quiet: readonly BriefProduct[];
  /** 조용한 상품에 온 새 소식 수. 없으면 키가 없다 */
  newPlaces: ReadonlyMap<number, number>;
} {
  const byProduct = new Map<number, ChangeRow[]>();
  for (const change of changes) {
    byProduct.set(change.productId, [...(byProduct.get(change.productId) ?? []), change]);
  }

  const candidates: BriefCandidate[] = [];
  const quiet: BriefProduct[] = [];
  const newPlaces = new Map<number, number>();
  for (const product of products) {
    const rows = byProduct.get(product.productId) ?? [];
    /*
     * **새 소식(조건 4 ~ 6)은 바뀐 곳이 아니다.** 같이 세면 새로 등록된 곳 2건이 「2곳이
     * 바뀌었습니다 · 다시 검수」 가 된다 (#724). 새 소식만 있는 상품은 다시 검수할 일이 없다.
     */
    const changed = rows.filter(isChange);
    const added = rows.length - changed.length;
    if (changed.length === 0) {
      quiet.push(product);
      if (added > 0) newPlaces.set(product.productId, added);
      continue;
    }
    /*
     * 배치는 알림을 만들며 그 상품을 다시 검수한다. 그 뒤에도 「다시 검수」 를 권하면 레이더
     * 카드(「알림 뒤에 다시 검수했어요 · 검수 결과 보기」)와 말이 어긋난다 (#735). 알림이
     * **하나라도** 마지막 검수 뒤에 왔으면 아직 다시 검수할 일이다.
     */
    const lastAuditAt = product.lastAuditAt;
    const reaudited = lastAuditAt !== null && changed.every((c) => c.detectedAt.getTime() < lastAuditAt.getTime());
    candidates.push({
      key: `CHANGE:${String(product.productId)}`,
      kind: 'CHANGE',
      productId: product.productId,
      region: null,
      action: reaudited ? 'VIEW_RESULT' : 'REAUDIT',
      facts: {
        product: product.name,
        startDate: product.startDate,
        released: product.released,
        changedCount: changed.length,
        // 사용자가 입력한 장소명이다. 공사 원문이 아니다 (DR-PR-001)
        changedPlaces: [...new Set(changed.map((c) => c.placeLabel).filter((p): p is string => p !== null))].slice(0, 5),
        ...(added > 0 ? { newPlaceCount: added } : {}),
        ...(reaudited ? { reauditedAfter: true } : {}),
      },
    });
  }

  for (const region of regions) {
    const news = toRegionNews(region);
    if (news === null) continue;
    candidates.push({
      key: `NEWS:${news.region.regnCd}:${news.region.signguCd ?? ''}:${news.region.month}`,
      kind: 'NEWS',
      productId: null,
      region: { regnCd: news.region.regnCd, signguCd: news.region.signguCd, month: news.region.month },
      action: 'NEW_PLAN',
      // 지역 이름은 싣지 않는다. 0콜로는 코드밖에 모른다 — 화면이 이름으로 바꿔 줄 머리에 적는다
      facts: { newPlaceCount: news.count, matchedKeywords: news.keywords },
    });
  }

  return { candidates, quiet, newPlaces };
}

/** 조건 1 ~ 3 과 표출 중단이 「바뀐 정보」 다. 4 ~ 6 은 새 소식이다 (FR-MO-030 ~ 035) */
function isChange(row: ChangeRow): boolean {
  return row.hidden || row.condition <= 3;
}

/**
 * 관심 지역 한 칸 → 새 소식 후보.
 *
 * **아직 세지 않았거나(`null`) 0 건이면 후보가 아니다.** 「아직 안 셌다」를 「새 소식이 없다」로
 * 바꿔 적지 않는다 (설계 원칙 3).
 */
function toRegionNews(row: Record<string, unknown>): {
  region: { regnCd: string; signguCd: string | null; month: string };
  count: number;
  keywords: readonly string[];
} | null {
  const region = row.region as { regnCd?: unknown; signguCd?: unknown } | undefined;
  const regnCd = typeof region?.regnCd === 'string' ? region.regnCd : null;
  const month = typeof row.month === 'string' ? row.month : null;
  const t1 = row.t1 as { count?: unknown; keywordHits?: unknown } | null | undefined;
  const count = Number((t1 ?? {}).count);
  if (regnCd === null || month === null || t1 === null || t1 === undefined || !Number.isFinite(count) || count <= 0) {
    return null;
  }

  const hits = Array.isArray(t1.keywordHits) ? t1.keywordHits : [];
  const keywords = hits
    .filter((h) => Array.isArray((h as { contentIds?: unknown }).contentIds)
      && ((h as { contentIds: unknown[] }).contentIds.length > 0))
    .map((h) => String((h as { keyword?: unknown }).keyword ?? ''))
    .filter((k) => k !== '');
  return {
    region: { regnCd, signguCd: typeof region?.signguCd === 'string' ? region.signguCd : null, month },
    count,
    keywords,
  };
}

/** 후보 목록 도구. 공사를 부르지 않는다 — 상품 번호를 증거로 적는다 */
function candidatesTool(
  candidates: readonly BriefCandidate[],
  quiet: readonly BriefProduct[],
  newPlaces: ReadonlyMap<number, number>,
): AgentTool {
  return {
    spec: {
      name: CANDIDATES_TOOL,
      description: '오늘의 할 일 후보와 할 일이 없는 상품을 받는다.',
      inputSchema: { type: 'object', properties: {} },
    },
    run: async (_input: unknown, evidence: AgentEvidence): Promise<string> => {
      for (const candidate of candidates) {
        if (candidate.productId !== null) evidence.add('productId', candidate.productId);
      }
      for (const product of quiet) evidence.add('productId', product.productId);
      return JSON.stringify({
        todos: candidates.map((c) => ({ key: c.key, kind: c.kind, ...c.facts })),
        quiet: quiet.map((p) => ({
          productId: p.productId, product: p.name, startDate: p.startDate,
          ...(newPlaces.has(p.productId) ? { newPlaceCount: newPlaces.get(p.productId) } : {}),
        })),
      });
    },
  };
}

interface Answer {
  readonly todos: readonly { key: string; reason: string }[];
  readonly quiet: readonly { productId: number; text: string }[];
}

function readAnswer(result: unknown): Answer {
  const row = (result ?? {}) as { todos?: unknown; quiet?: unknown };
  const todos = Array.isArray(row.todos) ? row.todos : [];
  const quiet = Array.isArray(row.quiet) ? row.quiet : [];
  return {
    todos: todos
      .map((t) => {
        const entry = t as Record<string, unknown>;
        return { key: text(entry.key) ?? '', reason: (text(entry.reason) ?? '').slice(0, BRIEF_REASON_MAX) };
      })
      .filter((t) => t.key !== '' && t.reason !== ''),
    quiet: quiet
      .map((q) => {
        const entry = q as Record<string, unknown>;
        return { productId: Number(entry.productId), text: (text(entry.text) ?? '').slice(0, BRIEF_REASON_MAX) };
      })
      .filter((q) => Number.isInteger(q.productId) && q.text !== ''),
  };
}

function describe(candidates: readonly BriefCandidate[], quiet: readonly BriefProduct[]): string {
  return `할 일 후보 ${String(candidates.length)}개와 할 일이 없는 상품 ${String(quiet.length)}개다. `
    + `${CANDIDATES_TOOL} 로 받아 후보마다 이유 한 줄을 쓰고, 할 일이 없는 상품에는 한 줄을 쓴다.`;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}
