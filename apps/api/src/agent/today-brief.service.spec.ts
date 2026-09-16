import { describe, expect, it } from 'vitest';
import type { BriefProduct, ChangeRow } from '../radar/radar.repository';
import {
  LlmClient, LlmUnavailableError,
  type LlmAssistantBlock, type LlmProvider, type LlmToolTurnRequest, type LlmToolTurnResult,
} from '../external/llm';
import { SUBMIT_TOOL } from './agent-runner';
import { AgentLock } from './agent-lock';
import { TodayBriefService, buildCandidates, type TodayBriefSource } from './today-brief.service';

const CONFIG = { provider: 'scripted', apiKey: 'k', modelStructure: 'm-s', modelNormalize: 'm-n', modelAgent: 'm-a' };

const use = (id: string, name: string, input: unknown): LlmAssistantBlock => ({ type: 'tool_use', id, name, input });
const candidates = (id: string): LlmAssistantBlock => use(id, 'today_candidates', {});
const submit = (value: unknown): LlmAssistantBlock => use('final', SUBMIT_TOOL, value);

class ScriptedLlmProvider implements LlmProvider {
  readonly name = 'scripted';
  readonly requests: LlmToolTurnRequest[] = [];
  constructor(private readonly turns: readonly (readonly LlmAssistantBlock[] | Error)[]) {}

  async structured(): Promise<never> {
    throw new Error('구조화 호출은 에이전트가 쓰지 않는다');
  }

  async toolTurn(req: LlmToolTurnRequest): Promise<LlmToolTurnResult> {
    this.requests.push({ ...req, turns: [...req.turns] });
    const next = this.turns[this.requests.length - 1];
    if (next === undefined) throw new Error('준비한 턴이 없다');
    if (next instanceof Error) throw next;
    return { blocks: next, stopReason: 'tool_use', model: 'scripted' };
  }
}

const product = (over: Partial<BriefProduct> = {}): BriefProduct => ({
  productId: 31, name: '강릉 감성 1박 2일', ldongRegnCd: '51', ldongSignguCd: '150',
  startDate: '2026-10-23', nights: 1, released: true, ...over,
});

const change = (over: Partial<ChangeRow> = {}): ChangeRow => ({
  notificationId: 9, productId: 31, productName: '강릉 감성 1박 2일', ktoContentId: '125769',
  condition: 1, hashFrom: 'a', hashTo: 'b', modifiedTime: null, hidden: false,
  detectedAt: new Date('2026-09-15T05:00:00Z'), placeLabel: '오죽헌', normalizedBefore: null, normalizedAfter: null,
  ...over,
});

const regionRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  region: { regnCd: '51', signguCd: '150' },
  month: '2026-10',
  t1: { count: 12, byType: {}, window: { from: '2026-08-17', to: '2026-09-15' }, computedAt: '2026-09-15T05:00:00.000Z', keywordHits: [] },
  t2: null,
  t3: null,
  ...over,
});

function sourceOf(options: {
  products?: readonly BriefProduct[];
  changes?: readonly ChangeRow[];
  regions?: readonly Record<string, unknown>[];
  lastBatchAt?: Date | null;
}): TodayBriefSource {
  return {
    upcomingProducts: async (): Promise<readonly BriefProduct[]> => options.products ?? [product()],
    changes: async (): Promise<{ total: number; rows: readonly ChangeRow[] }> => {
      const rows = options.changes ?? [change()];
      return { total: rows.length, rows };
    },
    regionSignals: async (): Promise<readonly Record<string, unknown>[]> => options.regions ?? [],
    lastBatchAt: async (): Promise<Date | null> =>
      (options.lastBatchAt === undefined ? new Date('2026-09-16T05:00:00Z') : options.lastBatchAt),
  };
}

function service(options: {
  products?: readonly BriefProduct[];
  changes?: readonly ChangeRow[];
  regions?: readonly Record<string, unknown>[];
  turns?: readonly (readonly LlmAssistantBlock[] | Error)[];
  provider?: ScriptedLlmProvider;
  lock?: AgentLock;
  llm?: () => LlmClient;
}): TodayBriefService {
  const provider = options.provider ?? new ScriptedLlmProvider(options.turns ?? []);
  return new TodayBriefService({
    radar: sourceOf(options),
    llm: options.llm ?? ((): LlmClient => new LlmClient({ provider, config: CONFIG })),
    lock: options.lock ?? new AgentLock(),
  });
}

const NOW = new Date('2026-09-16T10:00:00Z');

describe('할 일 후보와 순서 (FR-AG-030)', () => {
  it('출발일이 가까운 상품의 바뀐 정보가 먼저고 관심 지역 새 소식이 그다음이다', () => {
    const { candidates: built } = buildCandidates(
      [product({ productId: 41, startDate: '2026-11-02' }), product({ productId: 31, startDate: '2026-10-23' })]
        .sort((a, b) => a.startDate.localeCompare(b.startDate)),
      [change({ productId: 41 }), change({ productId: 31 })],
      [regionRow()],
    );

    expect(built.map((c) => c.key)).toEqual(['CHANGE:31', 'CHANGE:41', 'NEWS:51:150:2026-10']);
    expect(built.map((c) => c.action)).toEqual(['REAUDIT', 'REAUDIT', 'NEW_PLAN']);
  });

  it('🔴 바뀐 정보가 없는 상품은 할 일이 아니라 한 줄 대상이다 (FR-AG-031)', () => {
    const { candidates: built, quiet } = buildCandidates([product({ productId: 55 })], [], []);
    expect(built).toHaveLength(0);
    expect(quiet.map((p) => p.productId)).toEqual([55]);
  });

  it('🔴 아직 세지 않은 지역과 0 건인 지역은 새 소식이 아니다 — 모른다를 없다로 바꾸지 않는다', () => {
    expect(buildCandidates([], [], [regionRow({ t1: null })]).candidates).toHaveLength(0);
    expect(buildCandidates([], [], [regionRow({ t1: { count: 0, keywordHits: [] } })]).candidates).toHaveLength(0);
  });

  it('바뀐 곳 이름과 건수를 후보에 담는다 — 이유는 이 값으로만 쓴다', () => {
    const { candidates: built } = buildCandidates(
      [product()],
      [change({ placeLabel: '오죽헌' }), change({ notificationId: 10, placeLabel: '경포대' })],
      [],
    );
    expect(built[0]?.facts).toMatchObject({ changedCount: 2, places: ['오죽헌', '경포대'] });
  });
});

describe('TodayBriefService — 오늘 할 일 (FR-AG-030 · 031)', () => {
  it('후보마다 이유 한 줄을 붙이고 순서는 서버가 정한 그대로다', async () => {
    const result = await service({
      products: [product({ productId: 31, startDate: '2026-10-23' }), product({ productId: 41, startDate: '2026-11-02' })],
      changes: [change({ productId: 31 }), change({ productId: 41, notificationId: 10 })],
      regions: [regionRow()],
      turns: [
        [candidates('t1')],
        [submit({
          todos: [
            { key: 'NEWS:51:150:2026-10', reason: '강릉에 새로 등록된 곳이 12곳이에요' },
            { key: 'CHANGE:41', reason: '오죽헌 정보가 바뀌었어요' },
            { key: 'CHANGE:31', reason: '오죽헌 운영시간이 바뀌었어요' },
          ],
          quiet: [],
        })],
      ],
    }).brief(1, NOW);

    // 모델이 뒤집어 냈어도 서버 순서다
    expect(result.todos.map((t) => [t.kind, t.productId])).toEqual([['CHANGE', 31], ['CHANGE', 41], ['NEWS', null]]);
    expect(result.todos[2]?.region).toEqual({ regnCd: '51', signguCd: '150', month: '2026-10' });
    expect(result.todos.map((t) => t.action)).toEqual(['REAUDIT', 'REAUDIT', 'NEW_PLAN']);
    expect(result.incomplete).toBeNull();
    expect(result.basisAt).toBe('2026-09-16T05:00:00.000Z');
  });

  it('🔴 후보에 없는 할 일은 버린다 — 알림 · 새 소식에 없는 것을 만들어 내지 않는다 (FR-AG-003)', async () => {
    const result = await service({
      turns: [
        [candidates('t1')],
        [submit({ todos: [
          { key: 'CHANGE:31', reason: '오죽헌 운영시간이 바뀌었어요' },
          { key: 'CHANGE:999', reason: '어딘가 바뀌었어요' },
          { key: 'NEWS:11:110:2026-10', reason: '서울에 새 소식이 있어요' },
        ] })],
      ],
    }).brief(1, NOW);

    expect(result.todos).toHaveLength(1);
    expect(result.todos[0]?.productId).toBe(31);
  });

  it('🔴 할 일이 없는 상품의 한 줄도 도구가 준 상품만이다', async () => {
    const result = await service({
      products: [product({ productId: 31 }), product({ productId: 55, name: '태백 당일 산행' })],
      changes: [change({ productId: 31 })],
      turns: [
        [candidates('t1')],
        [submit({
          todos: [{ key: 'CHANGE:31', reason: '오죽헌 운영시간이 바뀌었어요' }],
          quiet: [
            { productId: 55, text: '태백 당일 산행은 바뀐 정보가 없어요.' },
            { productId: 777, text: '없는 상품이에요.' },
          ],
        })],
      ],
    }).brief(1, NOW);

    expect(result.quiet).toEqual([{ productId: 55, text: '태백 당일 산행은 바뀐 정보가 없어요.' }]);
  });

  it('🔴 같은 상품의 한 줄은 하나다 — 같은 상품이 두 번 적히지 않는다', async () => {
    const result = await service({
      products: [product({ productId: 55, name: '태백 당일 산행' })],
      changes: [],
      turns: [
        [candidates('t1')],
        [submit({ todos: [], quiet: [
          { productId: 55, text: '태백 당일 산행은 바뀐 정보가 없어요.' },
          { productId: 55, text: '태백 당일 산행은 조용해요.' },
        ] })],
      ],
    }).brief(1, NOW);

    expect(result.quiet).toEqual([{ productId: 55, text: '태백 당일 산행은 바뀐 정보가 없어요.' }]);
  });

  it('🔴 할 일이 0 이면 todos 는 비고 한 줄만 남는다', async () => {
    const result = await service({
      products: [product({ productId: 55, name: '태백 당일 산행' })],
      changes: [],
      turns: [
        [candidates('t1')],
        [submit({ todos: [], quiet: [{ productId: 55, text: '태백 당일 산행은 바뀐 정보가 없어요.' }] })],
      ],
    }).brief(1, NOW);

    expect(result.todos).toEqual([]);
    expect(result.quiet).toHaveLength(1);
    expect(result.incomplete).toBeNull();
  });

  it('🔴 볼 상품도 관심 지역도 없으면 모델을 부르지 않는다', async () => {
    const provider = new ScriptedLlmProvider([]);
    const result = await service({ products: [], changes: [], regions: [], provider }).brief(1, NOW);

    expect(result).toMatchObject({ todos: [], quiet: [], incomplete: null });
    expect(provider.requests).toHaveLength(0);
  });

  it('🔴 이유를 쓰지 못한 후보는 싣지 않고 incomplete 로 알린다 (EX-AG-002)', async () => {
    const result = await service({
      products: [product({ productId: 31 }), product({ productId: 41, startDate: '2026-11-02' })],
      changes: [change({ productId: 31 }), change({ productId: 41, notificationId: 10 })],
      turns: [[candidates('t1')], [submit({ todos: [{ key: 'CHANGE:31', reason: '운영시간이 바뀌었어요' }] })]],
    }).brief(1, NOW);

    expect(result.todos).toHaveLength(1);
    expect(result.incomplete).toEqual({ reasonCode: 'LLM_UNAVAILABLE', itemIds: [] });
  });

  it('🔴 모델이 실패해도 거절하지 않는다 — 빈 목록과 incomplete 다 (EX-AG-001)', async () => {
    const result = await service({ turns: [new LlmUnavailableError('TIMEOUT')] }).brief(1, NOW);

    expect(result.todos).toEqual([]);
    expect(result.incomplete).toEqual({ reasonCode: 'LLM_UNAVAILABLE', itemIds: [] });
    expect(result.basisAt).toBe('2026-09-16T05:00:00.000Z');
  });

  it('🔴 같은 계정의 같은 에이전트가 도는 중이면 429 다 (EX-AG-004)', async () => {
    const lock = new AgentLock();
    const busy = service({
      lock, turns: [[candidates('t1')], [submit({ todos: [{ key: 'CHANGE:31', reason: '바뀌었어요' }] })]],
    });
    const first = busy.brief(1, NOW);
    await expect(busy.brief(1, NOW)).rejects.toMatchObject({ reasonCode: 'RATE_LIMIT_EXCEEDED' });
    await first;
  });

  it('배치가 아직 돈 적 없으면 기준 시각은 지금이다', async () => {
    const result = await new TodayBriefService({
      radar: sourceOf({ lastBatchAt: null }),
      llm: () => new LlmClient({ provider: new ScriptedLlmProvider([[candidates('t1')], [submit({ todos: [] })]]), config: CONFIG }),
      lock: new AgentLock(),
    }).brief(1, NOW);

    expect(result.basisAt).toBe(NOW.toISOString());
  });

  it('모델을 못 쓰면 거절하지 않고 사람이 하는 길을 둔다 (FR-AG-005)', async () => {
    const result = await service({
      llm: () => { throw new LlmUnavailableError('NOT_CONFIGURED'); },
    }).brief(1, NOW);

    expect(result).toMatchObject({ todos: [], quiet: [], incomplete: { reasonCode: 'LLM_UNAVAILABLE', itemIds: [] } });
  });

  it('지시문에 순서를 바꾸지 말라고 적고 예측을 금한다 (FR-AG-030 · FR-RU-122)', async () => {
    const provider = new ScriptedLlmProvider([[candidates('t1')], [submit({ todos: [] })]]);
    await service({ provider }).brief(1, NOW);

    expect(provider.requests[0]?.system).toContain('순서를 바꾸거나');
    expect(provider.requests[0]?.system).toContain('예측을 쓰지 않는다');
  });
});
