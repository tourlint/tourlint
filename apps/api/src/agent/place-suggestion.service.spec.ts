import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DomainException } from '../common/domain.exception';
import { InMemoryApiCallLogger } from '../external/api-call-log';
import type { BudgetDecision } from '../external/budget-guard';
import { KtoClient, type KtoParams, type KtoTransport, type KtoTransportResult } from '../external/kto';
import {
  LlmClient, LlmUnavailableError,
  type LlmAssistantBlock, type LlmProvider, type LlmToolTurnRequest, type LlmToolTurnResult,
} from '../external/llm';
import { PlanItemRepository, type PlanItem, type PlanProduct } from '../plan/plan-item.repository';
import { SUBMIT_TOOL } from './agent-runner';
import { AgentLock } from './agent-lock';
import { PlaceSuggestionService, anchorOf, hasPlaceName, straightDistanceM } from './place-suggestion.service';

const allowed: BudgetDecision = { allowed: true, ratio: 0.1, reasonCode: null, warn: false, remaining: 720 };
const blocked: BudgetDecision = { allowed: false, ratio: 1, reasonCode: 'BUDGET_EXHAUSTED', warn: true, remaining: 0 };

const item = (over: Partial<PlanItem> = {}): PlanItem => ({
  id: 1, dayNo: 1, seq: 1, startTime: '10:00', endTime: '11:00', placeLabel: '오죽헌', itemType: 'SIGHT',
  contentId: null, contentTypeId: null, lcls2: null, mapx: null, mapy: null,
  matchStatus: 'PENDING', matchedBy: null, origin: null, walkId: null, ...over,
});

const product = (items: readonly PlanItem[]): PlanProduct => ({
  productId: 7, startDate: '2026-10-23', transport: 'CAR', regnCd: '51', signguCd: '150', items,
});

/** 상품 하나만 아는 읽기 저장소. 에이전트는 읽기만 한다 (FR-AG-001) */
function repositoryOf(value: PlanProduct | null): PlanItemRepository {
  return { product: async (): Promise<PlanProduct | null> => value } as unknown as PlanItemRepository;
}

/** 정해 둔 턴을 차례로 돌려주는 LLM. 실제 모델은 부르지 않는다 */
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

const CONFIG = { provider: 'scripted', apiKey: 'k', modelStructure: 'm-s', modelNormalize: 'm-n', modelAgent: 'm-a' };

const use = (id: string, name: string, input: unknown): LlmAssistantBlock => ({ type: 'tool_use', id, name, input });
const search = (id: string, itemId: number, keyword: string): LlmAssistantBlock =>
  use(id, 'search_places', { itemId, keyword });
const submit = (items: unknown[]): LlmAssistantBlock => use('final', SUBMIT_TOOL, { items });

const found = (itemId: number, contentId: string, over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ itemId, kind: 'FOUND', contentId, reason: '앞 일정과 가장 가까워요', ...over });

/** 지역 조건을 준 검색에만 강릉 곳을 주는 운송. 조건을 빼면 다른 시군구가 온다 */
class SearchTransport implements KtoTransport {
  readonly kind = 'http' as const;
  readonly calls: { operation: string; params: KtoParams }[] = [];
  constructor(private readonly byKeyword: Record<string, readonly Record<string, unknown>[]> = {}) {}

  async request(operation: string, params: KtoParams): Promise<KtoTransportResult> {
    this.calls.push({ operation, params });
    if (operation === 'detailCommon2') {
      return this.body({ items: { item: [detail(String(params.contentId ?? ''))] }, totalCount: 1 });
    }
    const keyword = String(params.keyword ?? '');
    const inRegion = params.lDongRegnCd === '51' && params.lDongSignguCd === '150';
    const items = inRegion ? this.byKeyword[keyword] ?? [] : [place({ contentid: '999', title: '속초 오죽헌' })];
    return this.body({ items: items.length === 0 ? '' : { item: items }, totalCount: items.length });
  }

  paramsOf(operation: string): readonly KtoParams[] {
    return this.calls.filter((c) => c.operation === operation).map((c) => c.params);
  }

  private body(body: unknown): KtoTransportResult {
    return {
      body: JSON.stringify({ response: { header: { resultCode: '0000', resultMsg: 'OK' }, body } }),
      httpStatus: 200,
    };
  }
}

const place = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  contentid: '125769', contenttypeid: '12', title: '오죽헌', addr1: '강릉시 율곡로3139번길 24',
  lclsSystm1: 'HS', lclsSystm2: 'HS01', mapx: '128.8783', mapy: '37.7796', ...over,
});

const detail = (contentId: string): Record<string, unknown> => ({
  contentid: contentId, contenttypeid: '39', title: '초당순두부', addr1: '강릉시 초당순두부길 77',
  lclsSystm2: 'FD01', showflag: '1',
});

function service(options: {
  items?: PlanProduct | null;
  turns?: readonly (readonly LlmAssistantBlock[] | Error)[];
  transport?: SearchTransport;
  budget?: BudgetDecision;
  lock?: AgentLock;
  llm?: () => LlmClient;
}): PlaceSuggestionService {
  const transport = options.transport ?? new SearchTransport();
  const provider = new ScriptedLlmProvider(options.turns ?? []);
  return new PlaceSuggestionService({
    items: repositoryOf(options.items === undefined ? product([]) : options.items),
    kto: () => new KtoClient({ transport, logger: new InMemoryApiCallLogger(), sleep: async () => undefined }),
    llm: options.llm ?? ((): LlmClient => new LlmClient({ provider, config: CONFIG })),
    budget: async () => options.budget ?? allowed,
    lock: options.lock ?? new AgentLock(),
  });
}

describe('줄에 찾을 이름이 있는가 (FR-AG-011)', () => {
  it('🔴 일반 낱말로만 된 줄은 이름이 없는 것이다 — 비슷한 곳을 붙이지 않는다', () => {
    expect(hasPlaceName('점심')).toBe(false);
    expect(hasPlaceName('숙소 체크인')).toBe(false);
    expect(hasPlaceName('   ')).toBe(false);
    expect(hasPlaceName(null)).toBe(false);
  });

  it('일반 낱말이 섞여 있어도 이름이 있으면 찾는다', () => {
    expect(hasPlaceName('초당순두부 점심')).toBe(true);
    expect(hasPlaceName('경포대')).toBe(true);
  });
});

describe('앞뒤 고른 줄과의 거리 (FR-AG-010)', () => {
  const items = [
    item({ id: 1, seq: 1, matchStatus: 'CONFIRMED', mapx: 128.87, mapy: 37.77 }),
    item({ id: 2, seq: 2 }),
    item({ id: 3, seq: 3, matchStatus: 'CONFIRMED', mapx: 128.90, mapy: 37.80 }),
    item({ id: 4, dayNo: 2, seq: 1 }),
  ];

  it('앞의 고른 줄을 기준으로 잡고, 앞이 없으면 뒤를 본다', () => {
    expect(anchorOf(items, items[1] as PlanItem)).toEqual({ mapx: 128.87, mapy: 37.77 });
    expect(anchorOf([items[1] as PlanItem, items[2] as PlanItem], items[1] as PlanItem))
      .toEqual({ mapx: 128.90, mapy: 37.80 });
  });

  it('🔴 날이 다른 줄은 기준이 되지 않는다 — 자고 일어난 뒤의 거리다', () => {
    expect(anchorOf(items, items[3] as PlanItem)).toBeNull();
  });

  it('좌표가 없으면 거리도 없다 — 직선거리로도 지어내지 않는다', () => {
    expect(straightDistanceM(null, { mapx: 128.9, mapy: 37.8 })).toBeNull();
    expect(straightDistanceM({ mapx: 128.87, mapy: 37.77 }, { mapx: 128.87, mapy: 37.77 })).toBe(0);
  });
});

describe('PlaceSuggestionService — 고르지 않은 줄의 장소 찾기 (FR-AG-010 ~ 012)', () => {
  const eightLines = [
    item({ id: 11, seq: 1, placeLabel: '오죽헌' }),
    item({ id: 12, seq: 2, placeLabel: '점심' }),
    item({ id: 13, seq: 3, placeLabel: '초당순두부 점심' }),
    item({ id: 14, seq: 4, placeLabel: '경포대' }),
    item({ id: 15, seq: 5, placeLabel: '강릉중앙시장' }),
    item({ id: 16, seq: 6, placeLabel: '숙소 체크인' }),
    item({ id: 17, seq: 7, placeLabel: '안목해변 카페거리' }),
    item({ id: 18, seq: 8, placeLabel: '없는곳' }),
  ];

  const sixFound = [
    [
      search('t1', 11, '오죽헌'), search('t2', 13, '초당순두부 점심'), search('t3', 14, '경포대'),
      search('t4', 15, '강릉중앙시장'), search('t5', 17, '안목해변 카페거리'), search('t6', 18, '없는곳'),
    ],
    [submit([
      found(11, '125769'), found(13, '2465063'), found(14, '125790'), found(15, '2868839'),
      found(17, '2891773'), { itemId: 18, kind: 'NOT_FOUND', reason: '이름과 맞는 곳이 없어요' },
    ])],
  ];

  const transportOf = (): SearchTransport => new SearchTransport({
    오죽헌: [place()],
    '초당순두부 점심': [place({ contentid: '2465063', title: '초당순두부', contenttypeid: '39', lclsSystm2: 'FD01' })],
    경포대: [place({ contentid: '125790', title: '강릉 경포대' })],
    강릉중앙시장: [place({ contentid: '2868839', title: '강릉중앙시장', contenttypeid: '38', lclsSystm2: 'SH01' })],
    '안목해변 카페거리': [place({ contentid: '2891773', title: '안목해변', lclsSystm2: 'NA02' })],
  });

  it('여덟 줄에서 찾은 곳 다섯 · 찾지 못한 곳 하나 · 이름이 없는 줄 둘', async () => {
    const result = await service({ items: product(eightLines), turns: sixFound, transport: transportOf() })
      .suggest(1, 7, null);

    expect(result.summary).toEqual({ found: 5, notFound: 1, noName: 2 });
    expect(result.incomplete).toBeNull();
    expect(result.items.map((i) => i.itemId)).toEqual([11, 12, 13, 14, 15, 16, 17, 18]);
    expect(result.items.find((i) => i.itemId === 12)?.kind).toBe('NO_NAME');
    expect(result.items.find((i) => i.itemId === 13)?.place)
      .toMatchObject({ contentId: '2465063', title: '초당순두부', kindName: '한식' });
  });

  it('🔴 이름이 없는 줄만 있으면 모델도 공사도 부르지 않는다', async () => {
    const transport = transportOf();
    const provider = new ScriptedLlmProvider([]);
    const result = await new PlaceSuggestionService({
      items: repositoryOf(product([item({ id: 21, placeLabel: '점심' }), item({ id: 22, placeLabel: '숙소 체크인' })])),
      kto: () => new KtoClient({ transport, logger: new InMemoryApiCallLogger() }),
      llm: () => new LlmClient({ provider, config: CONFIG }),
      budget: async () => allowed,
      lock: new AgentLock(),
    }).suggest(1, 7, null);

    expect(result.summary).toEqual({ found: 0, notFound: 0, noName: 2 });
    expect(provider.requests).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it('🔴 검색은 상품 지역으로 고정한다 — 모델이 지역을 넓히지 못한다', async () => {
    const transport = transportOf();
    const result = await service({
      items: product([item({ id: 11, placeLabel: '오죽헌' })]),
      turns: [[search('t1', 11, '오죽헌')], [submit([found(11, '125769')])]],
      transport,
    }).suggest(1, 7, null);

    expect(transport.paramsOf('searchKeyword2')[0])
      .toMatchObject({ keyword: '오죽헌', lDongRegnCd: '51', lDongSignguCd: '150' });
    // 지역을 빼고 부르면 속초 곳(999)이 오고, 그 번호는 응답에 없다
    expect(result.items[0]?.place?.contentId).toBe('125769');
  });

  it('🔴 도구 결과에 없던 번호를 고른 줄은 통째로 버린다 (FR-AG-003)', async () => {
    const result = await service({
      items: product([item({ id: 11, placeLabel: '오죽헌' }), item({ id: 14, placeLabel: '경포대' })]),
      turns: [[search('t1', 11, '오죽헌')], [submit([found(11, '9999999'), found(14, '125769')])]],
      transport: transportOf(),
    }).suggest(1, 7, null);

    // 11 은 지어낸 번호라 버리고, 14 는 도구가 받아 둔 125769 라 남는다
    expect(result.items.map((i) => i.itemId)).toEqual([14]);
    expect(result.incomplete).toEqual({ reasonCode: 'LLM_UNAVAILABLE', itemIds: [11] });
  });

  it('🔴 다른 후보도 도구 결과에 있던 것만, 최대 셋이다', async () => {
    const many = [place(), place({ contentid: '2', title: '둘' }), place({ contentid: '3', title: '셋' }),
      place({ contentid: '4', title: '넷' }), place({ contentid: '5', title: '다섯' })];
    const result = await service({
      items: product([item({ id: 11, placeLabel: '오죽헌' })]),
      turns: [
        [search('t1', 11, '오죽헌')],
        [submit([found(11, '125769', { alternativeContentIds: ['2', '3', '4', '5', '77777'] })])],
      ],
      transport: new SearchTransport({ 오죽헌: many }),
    }).suggest(1, 7, null);

    expect(result.items[0]?.alternatives.map((a) => a.contentId)).toEqual(['2', '3', '4']);
  });

  it('🔴 요청하지 않은 줄은 응답에 넣지 않는다 — 일정에 없는 장소를 권하지 않는다 (FR-AG-012)', async () => {
    const result = await service({
      items: product([item({ id: 11, placeLabel: '오죽헌' }), item({ id: 14, placeLabel: '경포대' })]),
      // 99 는 요청하지 않은 줄이다. 번호는 도구 결과에 있던 것이라 증거 검사로는 걸리지 않는다
      turns: [[search('t1', 11, '오죽헌')], [submit([found(11, '125769'), found(99, '125769')])]],
      transport: transportOf(),
    }).suggest(1, 7, [11]);

    expect(result.items.map((i) => i.itemId)).toEqual([11]);
  });

  it('🔴 모델이 실패하면 끝난 줄만 싣고 incomplete 로 알린다 (EX-AG-002)', async () => {
    const result = await service({
      items: product([item({ id: 11, placeLabel: '오죽헌' }), item({ id: 12, placeLabel: '점심' })]),
      turns: [new LlmUnavailableError('TIMEOUT')],
      transport: transportOf(),
    }).suggest(1, 7, null);

    expect(result.items.map((i) => i.kind)).toEqual(['NO_NAME']);
    expect(result.incomplete).toEqual({ reasonCode: 'LLM_UNAVAILABLE', itemIds: [11] });
  });

  it('🔴 도구의 예산이 막히면 BUDGET_EXHAUSTED 로 알린다 — 거절하지 않는다', async () => {
    let calls = 0;
    const provider = new ScriptedLlmProvider([[search('t1', 11, '오죽헌')], [submit([])]]);
    const result = await new PlaceSuggestionService({
      items: repositoryOf(product([item({ id: 11, placeLabel: '오죽헌' })])),
      kto: () => new KtoClient({ transport: transportOf(), logger: new InMemoryApiCallLogger() }),
      llm: () => new LlmClient({ provider, config: CONFIG }),
      // 실행 전 게이트는 통과하고 도구를 부를 때 막힌다
      budget: async () => (++calls === 1 ? allowed : blocked),
      lock: new AgentLock(),
    }).suggest(1, 7, null);

    expect(result.incomplete).toEqual({ reasonCode: 'BUDGET_EXHAUSTED', itemIds: [11] });
  });

  it('🔴 예산이 다 찼으면 부르기 전에 429 다 (EI-CM-012)', async () => {
    const transport = transportOf();
    await expect(service({
      items: product([item({ id: 11, placeLabel: '오죽헌' })]), transport, budget: blocked,
    }).suggest(1, 7, null)).rejects.toMatchObject({ reasonCode: 'BUDGET_EXHAUSTED' });
    expect(transport.calls).toHaveLength(0);
  });

  it('🔴 같은 계정의 같은 에이전트가 도는 중이면 429 다 (EX-AG-004)', async () => {
    const lock = new AgentLock();
    const busy = service({
      items: product([item({ id: 11, placeLabel: '오죽헌' })]),
      turns: [[submit([found(11, '125769')])]],
      transport: transportOf(),
      lock,
    });
    const first = busy.suggest(1, 7, null);
    await expect(busy.suggest(1, 7, null)).rejects.toMatchObject({ reasonCode: 'RATE_LIMIT_EXCEEDED' });
    await first;
  });

  it('🔴 모델을 못 쓰면 거절하지 않고 사람이 하는 길을 둔다 (FR-AG-005)', async () => {
    const result = await service({
      items: product([item({ id: 11, placeLabel: '오죽헌' })]),
      llm: () => { throw new LlmUnavailableError('NOT_CONFIGURED'); },
    }).suggest(1, 7, null);

    expect(result.items).toHaveLength(0);
    expect(result.incomplete).toEqual({ reasonCode: 'LLM_UNAVAILABLE', itemIds: [11] });
  });

  it('🔴 비표출로 확인된 곳은 고를 수 없다 (FR-PL-019)', async () => {
    const transport = new SearchTransport({ 오죽헌: [place({ contentid: '125769' })] });
    const hidden: KtoTransport = {
      kind: 'http',
      request: async (operation, params): Promise<KtoTransportResult> => (operation === 'detailCommon2'
        ? {
          body: JSON.stringify({ response: { header: { resultCode: '0000', resultMsg: 'OK' },
            body: { items: { item: [{ ...detail(String(params.contentId ?? '')), showflag: '0' }] }, totalCount: 1 } } }),
          httpStatus: 200,
        }
        : transport.request(operation, params)),
    };
    const provider = new ScriptedLlmProvider([
      [search('t1', 11, '오죽헌')],
      [use('t2', 'place_detail', { contentId: '125769' })],
      [submit([found(11, '125769')])],
    ]);
    const result = await new PlaceSuggestionService({
      items: repositoryOf(product([item({ id: 11, placeLabel: '오죽헌' })])),
      kto: () => new KtoClient({ transport: hidden, logger: new InMemoryApiCallLogger() }),
      llm: () => new LlmClient({ provider, config: CONFIG }),
      budget: async () => allowed,
      lock: new AgentLock(),
    }).suggest(1, 7, null);

    expect(result.items).toHaveLength(0);
    expect(result.incomplete?.itemIds).toEqual([11]);
  });

  it('🔴 검색 결과의 비표출은 고를 수 없다 (FR-PL-019)', async () => {
    const result = await service({
      items: product([item({ id: 11, placeLabel: '오죽헌' })]),
      turns: [[search('t1', 11, '오죽헌')], [submit([found(11, '125769')])]],
      transport: new SearchTransport({ 오죽헌: [place({ showflag: '0' })] }),
    }).suggest(1, 7, null);

    expect(result.items).toHaveLength(0);
    expect(result.incomplete?.itemIds).toEqual([11]);
  });

  it('🔴 검색에 나오지 않은 번호는 상세도 부르지 않는다 — 모르는 번호를 조회로 만들어 주지 않는다', async () => {
    const transport = transportOf();
    await service({
      items: product([item({ id: 11, placeLabel: '오죽헌' })]),
      turns: [[use('t1', 'place_detail', { contentId: '3333333' })], [submit([])]],
      transport,
    }).suggest(1, 7, null);

    expect(transport.paramsOf('detailCommon2')).toHaveLength(0);
  });

  it('🔴 이미 고른 줄과 직접 정한 곳은 제안 대상이 아니다 (FR-AG-010)', async () => {
    const provider = new ScriptedLlmProvider([]);
    const result = await new PlaceSuggestionService({
      items: repositoryOf(product([
        item({ id: 11, placeLabel: '오죽헌', matchStatus: 'CONFIRMED', contentId: '125769' }),
        item({ id: 12, placeLabel: '펜션', matchStatus: 'EXCLUDED' }),
      ])),
      kto: () => new KtoClient({ transport: transportOf(), logger: new InMemoryApiCallLogger() }),
      llm: () => new LlmClient({ provider, config: CONFIG }),
      budget: async () => allowed,
      lock: new AgentLock(),
    }).suggest(1, 7, null);

    expect(result.items).toHaveLength(0);
    expect(provider.requests).toHaveLength(0);
  });

  it('지시문과 입력에 계정 정보가 없다 (EI-LM-009)', async () => {
    const provider = new ScriptedLlmProvider([[search('t1', 11, '오죽헌')], [submit([found(11, '125769')])]]);
    await new PlaceSuggestionService({
      items: repositoryOf(product([item({ id: 11, placeLabel: '오죽헌' })])),
      kto: () => new KtoClient({ transport: transportOf(), logger: new InMemoryApiCallLogger() }),
      llm: () => new LlmClient({ provider, config: CONFIG }),
      budget: async () => allowed,
      lock: new AgentLock(),
    }).suggest(1, 7, null);

    const request = provider.requests[0];
    const turn = request?.turns[0];
    const input = turn?.role === 'user' ? turn.text : '';
    expect(input).toContain('줄 11');
    expect(`${request?.system ?? ''}${input}`).not.toMatch(/accountId|이메일|@|비밀번호/);
  });
});

const URL = process.env.TEST_DATABASE_URL;

if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

describe.skipIf(URL === undefined)('PlaceSuggestionService — 실 DB', () => {
  let pool: Pool;
  let accountId: number;
  let theirId: number;
  let productId: number;

  const live = (turns: readonly (readonly LlmAssistantBlock[] | Error)[]): PlaceSuggestionService =>
    new PlaceSuggestionService({
      items: new PlanItemRepository(pool),
      kto: () => new KtoClient({
        transport: new SearchTransport({ 오죽헌: [place()] }), logger: new InMemoryApiCallLogger(),
      }),
      llm: () => new LlmClient({ provider: new ScriptedLlmProvider(turns), config: CONFIG }),
      budget: async () => allowed,
      lock: new AgentLock(),
    });

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 4 });
    const accounts = await pool.query<{ id: string }>(
      `INSERT INTO account (email, password_hash) VALUES ($1,'x'), ($2,'x') RETURNING id`,
      [`suggest-${String(process.pid)}@t.test`, `suggest-other-${String(process.pid)}@t.test`],
    );
    accountId = Number(accounts.rows[0]?.id);
    theirId = Number(accounts.rows[1]?.id);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM account WHERE id = ANY($1::bigint[])', [[accountId, theirId]]);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query('DELETE FROM product WHERE account_id = ANY($1::bigint[])', [[accountId, theirId]]);
  });

  const newProduct = async (owner: number): Promise<number> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO product (account_id, name, ldong_regn_cd, ldong_signgu_cd, start_date, nights, transport)
       VALUES ($1,'강릉 1박 2일','51','150', DATE '2026-10-23', 1, 'CAR') RETURNING id`,
      [owner],
    );
    const id = Number(rows[0]?.id);
    await pool.query(
      `INSERT INTO itinerary_item
         (product_id, day_no, seq, start_time, end_time, end_time_source, place_label, item_type, match_status)
       VALUES ($1, 1, 1, '10:00'::time, '11:00'::time, 'INPUT', '오죽헌', 'SIGHT', 'PENDING')`,
      [id],
    );
    return id;
  };

  it('🔴 남의 상품은 찾을 수 없다 (PM-DA-002)', async () => {
    productId = await newProduct(theirId);
    await expect(live([]).suggest(accountId, productId, null))
      .rejects.toBeInstanceOf(DomainException);
  });

  it('🔴 실행해도 상품 · 항목이 그대로다 — 고르는 것은 사람이다 (FR-AG-001 · 012)', async () => {
    productId = await newProduct(accountId);
    const before = await rowsOf(pool, productId);

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM itinerary_item WHERE product_id = $1`, [productId],
    );
    const itemId = Number(rows[0]?.id);
    const result = await live([[search('s1', itemId, '오죽헌')], [submit([found(itemId, '125769')])]])
      .suggest(accountId, productId, null);

    expect(result.items[0]).toMatchObject({ itemId, kind: 'FOUND' });
    expect(await rowsOf(pool, productId)).toEqual(before);
  });
});

/** 상품 · 항목의 지금 모습. 에이전트가 하나라도 바꾸면 달라진다 */
async function rowsOf(pool: Pool, productId: number): Promise<Record<string, unknown>[]> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT id, place_label, match_status, matched_by, kto_content_id, updated_at
       FROM itinerary_item WHERE product_id = $1 ORDER BY id`,
    [productId],
  );
  return rows;
}
