import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Severity } from '@tourlint/shared';
import { AuditService } from '../audit/audit.service';
import type { ItineraryItemRow, ProductRow } from '../audit/audit-runner';
import { DomainException } from '../common/domain.exception';
import { InMemoryApiCallLogger } from '../external/api-call-log';
import type { BudgetDecision } from '../external/budget-guard';
import { KtoClient, type KtoParams, type KtoTransport, type KtoTransportResult } from '../external/kto';
import {
  LlmClient, LlmUnavailableError,
  type LlmAssistantBlock, type LlmProvider, type LlmToolTurnRequest, type LlmToolTurnResult,
} from '../external/llm';
import type { StoredAuditRun, StoredFinding } from '../persistence/audit-result.repository';
import { SUBMIT_TOOL } from './agent-runner';
import { AgentLock } from './agent-lock';
import { CheckQuestionService, unverifiedPlaces, type CheckQuestionSource } from './check-question.service';

const allowed: BudgetDecision = { allowed: true, ratio: 0.1, reasonCode: null, warn: false, remaining: 720 };
const blocked: BudgetDecision = { allowed: false, ratio: 1, reasonCode: 'BUDGET_EXHAUSTED', warn: true, remaining: 0 };

const CONFIG = { provider: 'scripted', apiKey: 'k', modelStructure: 'm-s', modelNormalize: 'm-n', modelAgent: 'm-a' };

const use = (id: string, name: string, input: unknown): LlmAssistantBlock => ({ type: 'tool_use', id, name, input });
const list = (id: string): LlmAssistantBlock => use(id, 'unverified_places', {});
const contact = (id: string, itemId: number): LlmAssistantBlock => use(id, 'place_contact', { itemId });
const submit = (places: unknown[]): LlmAssistantBlock => use('final', SUBMIT_TOOL, { places });

const answer = (itemId: number, over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ itemId, questions: ['그날 문을 여나요?', '몇 시까지 하나요?'], ...over });

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

/** 공통정보 · 소개정보만 주는 운송. 어느 것이 몇 번 불렸는지 센다 */
class ContactTransport implements KtoTransport {
  readonly kind = 'http' as const;
  readonly calls: { operation: string; params: KtoParams }[] = [];
  constructor(private readonly common: Record<string, unknown> = { tel: '033-640-4471' },
    private readonly intro: Record<string, unknown> = {}) {}

  async request(operation: string, params: KtoParams): Promise<KtoTransportResult> {
    this.calls.push({ operation, params });
    const item = operation === 'detailCommon2'
      ? { contentid: String(params.contentId ?? ''), ...this.common }
      : { contentid: String(params.contentId ?? ''), ...this.intro };
    return {
      body: JSON.stringify({ response: { header: { resultCode: '0000', resultMsg: 'OK' },
        body: { items: { item: [item] }, totalCount: 1 } } }),
      httpStatus: 200,
    };
  }

  countOf(operation: string): number {
    return this.calls.filter((c) => c.operation === operation).length;
  }
}

const finding = (over: Partial<StoredFinding> = {}): StoredFinding => ({
  id: 301, ruleCode: 'R01', ruleVersion: '1.0.0', severity: 'UNVERIFIED' as Severity,
  reasonCode: 'NO_HOURS_INFO', targetItemId: 25, targetItemId2: null, message: '운영시간을 확인할 수 없습니다',
  evidence: {}, requiresExternal: true, externalSource: 'KTO', dismissReason: null, confirmed: false,
  needsConfirmation: false, dismissed: false, patches: [], ...over,
} as unknown as StoredFinding);

const run = (findings: readonly StoredFinding[]): StoredAuditRun =>
  ({ id: 812, productId: 31, findings } as unknown as StoredAuditRun);

const item = (over: Partial<ItineraryItemRow> = {}): ItineraryItemRow => ({
  id: 25, dayNo: 1, seq: 3, startTime: '19:30', endTime: '20:30', endTimeSource: 'INPUT',
  placeLabel: '소나무집', itemType: 'MEAL', ktoContentId: '2465063', contentTypeId: 39,
  lclsSystm1: 'FD', lclsSystm2: 'FD01', lclsSystm3: null, mapX: 128.89, mapY: 37.79, matchStatus: 'CONFIRMED',
  ...over,
} as ItineraryItemRow);

const PRODUCT = { id: 31, startDate: '2026-10-23', nights: 1 } as ProductRow;

function sourceOf(options: { run?: StoredAuditRun; items?: readonly ItineraryItemRow[]; owned?: boolean; labels?: ReadonlyMap<number, string> }): CheckQuestionSource {
  return {
    ...(options.labels === undefined ? {} : { displayLabels: async (): Promise<ReadonlyMap<number, string>> => options.labels ?? new Map() }),
    assertOwns: async (): Promise<void> => {
      if (options.owned === false) throw new DomainException(404, 'NOT_FOUND', '검수 결과를 찾을 수 없습니다.');
    },
    getRun: async (): Promise<StoredAuditRun> => options.run ?? run([finding()]),
    itemsOf: async (): Promise<readonly ItineraryItemRow[]> => options.items ?? [item()],
    productOf: async (): Promise<ProductRow | null> => PRODUCT,
  };
}

function service(options: {
  run?: StoredAuditRun;
  items?: readonly ItineraryItemRow[];
  owned?: boolean;
  labels?: ReadonlyMap<number, string>;
  turns?: readonly (readonly LlmAssistantBlock[] | Error)[];
  transport?: ContactTransport;
  budget?: BudgetDecision;
  lock?: AgentLock;
  provider?: ScriptedLlmProvider;
}): CheckQuestionService {
  const provider = options.provider ?? new ScriptedLlmProvider(options.turns ?? []);
  return new CheckQuestionService({
    audit: sourceOf(options),
    kto: () => new KtoClient({
      transport: options.transport ?? new ContactTransport(), logger: new InMemoryApiCallLogger(),
    }),
    llm: () => new LlmClient({ provider, config: CONFIG }),
    budget: async () => options.budget ?? allowed,
    lock: options.lock ?? new AgentLock(),
  });
}

describe('확인 필요 목록을 곳마다 묶는다 (FR-AG-020)', () => {
  it('같은 항목의 확인 필요 항목은 한 곳으로 묶이고 방문 날짜는 출발일 + 일차다', () => {
    const places = unverifiedPlaces(
      run([finding({ id: 301 }), finding({ id: 302, message: '휴무일을 확인할 수 없습니다' })]),
      [item({ dayNo: 2 })],
      PRODUCT,
    );
    expect(places).toHaveLength(1);
    expect(places[0]?.findingIds).toEqual([301, 302]);
    expect(places[0]?.visit).toEqual({ dayNo: 2, date: '2026-10-24', start: '19:30' });
  });

  it('🔴 확인했다고 누른 항목과 항목을 가리키지 않는 항목은 빼고 본다', () => {
    expect(unverifiedPlaces(run([finding({ confirmed: true })]), [item()], PRODUCT)).toHaveLength(0);
    expect(unverifiedPlaces(run([finding({ targetItemId: null })]), [item()], PRODUCT)).toHaveLength(0);
  });

  it('🔴 일정에 없는 항목을 가리키는 판정은 곳이 되지 않는다 — 전화할 데가 없다', () => {
    expect(unverifiedPlaces(run([finding({ targetItemId: 999 })]), [item()], PRODUCT)).toHaveLength(0);
  });

  it('🔴 이름을 저장하지 않은 곳은 표시 이름과 온전한 이유 문장을 준다 — 빈 자리를 모델에 넘기지 않는다 (#908)', () => {
    const places = unverifiedPlaces(
      run([finding({
        ruleCode: 'R08', reasonCode: 'ROUTE_PROVIDER_FAILED', targetItemId: 25, targetItemId2: 26,
        message: ' →  이동시간을 조회하지 못했습니다. 직접 확인해 주세요.',
      })]),
      [item({ placeLabel: '' }), item({ id: 26, seq: 4, placeLabel: '' })],
      PRODUCT,
      new Map([[25, '세인트존스 호텔'], [26, '주문진 등대']]),
    );
    expect(places.map((p) => [p.placeLabel, p.reasons])).toEqual([
      ['세인트존스 호텔', ['세인트존스 호텔 → 주문진 등대 이동시간을 조회하지 못했습니다. 직접 확인해 주세요.']],
    ]);
  });

  it('확인 필요가 아닌 판정은 넣지 않는다 — 여기는 직접 확인할 곳만이다', () => {
    expect(unverifiedPlaces(run([finding({ severity: 'ERROR' as Severity })]), [item()], PRODUCT)).toHaveLength(0);
    expect(unverifiedPlaces(
      run([finding({ severity: 'WARNING' as Severity, needsConfirmation: true } as Partial<StoredFinding>)]),
      [item()], PRODUCT,
    )).toHaveLength(1);
  });
});

describe('CheckQuestionService — 전화로 물어볼 내용 (FR-AG-020 ~ 022)', () => {
  it('🔴 확인할 곳이 없으면 모델도 공사도 부르지 않는다', async () => {
    const provider = new ScriptedLlmProvider([]);
    const transport = new ContactTransport();
    const result = await service({ run: run([]), provider, transport }).questions(1, 812);

    expect(result).toEqual({ places: [], incomplete: null });
    expect(provider.requests).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it('🔴 모델에게 주는 곳 목록에 표시 이름을 싣는다 — 결과 화면과 같은 이름이다 (#908)', async () => {
    const provider = new ScriptedLlmProvider([[list('t1')], [submit([answer(25)])]]);
    await service({
      provider, items: [item({ placeLabel: '' })], labels: new Map([[25, '세인트존스 호텔']]),
      run: run([finding({ message: ' — 운영시간을 확인할 수 없습니다' })]),
    }).questions(7, 812);
    const sent = JSON.stringify(provider.requests);
    expect(sent).toContain('세인트존스 호텔 — 운영시간을 확인할 수 없습니다');
    expect(sent).toContain('19:30 · 세인트존스 호텔');
  });

  it('🔴 방문 날짜 · 시각은 항목 값 그대로다 — 모델이 쓴 값을 쓰지 않는다', async () => {
    const result = await service({
      turns: [[list('t1'), contact('t2', 25)], [submit([answer(25, { tel: '033-640-4471', visit: { dayNo: 9, date: '2026-01-01', start: '03:00' } })])]],
    }).questions(1, 812);

    expect(result.places[0]?.visit).toEqual({ dayNo: 1, date: '2026-10-23', start: '19:30' });
    expect(result.places[0]?.tel).toBe('033-640-4471');
    expect(result.places[0]?.questions).toHaveLength(2);
  });

  it('🔴 도구 결과에 없던 전화번호는 null 이다 — 지어낸 번호로 전화하게 두지 않는다 (EX-AG-003 · 005)', async () => {
    const result = await service({
      turns: [[list('t1')], [submit([answer(25, { tel: '02-1234-5678' })])]],
    }).questions(1, 812);

    expect(result.places[0]?.tel).toBeNull();
    // 곳과 질문은 살아 있다. 번호만 비운다
    expect(result.places[0]?.questions).toHaveLength(2);
  });

  it('하이픈을 다르게 써도 도구가 준 번호면 그대로 싣는다', async () => {
    const result = await service({
      turns: [[list('t1'), contact('t2', 25)], [submit([answer(25, { tel: '033 640 4471' })])]],
    }).questions(1, 812);

    expect(result.places[0]?.tel).toBe('033 640 4471');
  });

  it('🔴 공통정보에 번호가 없으면 소개정보 문의처를 본다 (FR-AU-017 과 같은 두 자리)', async () => {
    const transport = new ContactTransport({ tel: '' }, { infocenterfood: '033-652-2937' });
    const result = await service({
      transport,
      turns: [[list('t1'), contact('t2', 25)], [submit([answer(25, { tel: '033-652-2937' })])]],
    }).questions(1, 812);

    expect(result.places[0]?.tel).toBe('033-652-2937');
    expect(transport.countOf('detailCommon2')).toBe(1);
    expect(transport.countOf('detailIntro2')).toBe(1);
  });

  it('공통정보에 번호가 있으면 소개정보는 부르지 않는다 — 곳마다 1콜이다', async () => {
    const transport = new ContactTransport();
    await service({
      transport,
      turns: [[list('t1'), contact('t2', 25)], [submit([answer(25, { tel: '033-640-4471' })])]],
    }).questions(1, 812);

    expect(transport.countOf('detailCommon2')).toBe(1);
    expect(transport.countOf('detailIntro2')).toBe(0);
  });

  it('같은 곳을 두 번 물어도 공사는 한 번이다 (10분 캐시)', async () => {
    const transport = new ContactTransport();
    await service({
      transport,
      turns: [[list('t1'), contact('t2', 25), contact('t3', 25)], [submit([answer(25, { tel: '033-640-4471' })])]],
    }).questions(1, 812);

    expect(transport.countOf('detailCommon2')).toBe(1);
  });

  it('🔴 직접 정한 곳은 문의처를 조회하지 않는다 — 공사에 없는 곳이다', async () => {
    const transport = new ContactTransport();
    const result = await service({
      transport,
      items: [item({ ktoContentId: null, contentTypeId: null, matchStatus: 'EXCLUDED' })],
      turns: [[list('t1'), contact('t2', 25)], [submit([answer(25)])]],
    }).questions(1, 812);

    expect(transport.calls).toHaveLength(0);
    expect(result.places[0]?.tel).toBeNull();
  });

  it('🔴 도구가 주지 않은 곳은 버리고 못 끝낸 곳으로 남긴다 (FR-AG-003)', async () => {
    const result = await service({
      turns: [[list('t1')], [submit([answer(99), answer(25)])]],
    }).questions(1, 812);

    expect(result.places.map((p) => p.itemId)).toEqual([25]);
    expect(result.incomplete).toBeNull();
  });

  it('🔴 질문이 없는 곳은 싣지 않는다 — 빈 카드를 만들지 않는다', async () => {
    const result = await service({
      turns: [[list('t1')], [submit([answer(25, { questions: [] })])]],
    }).questions(1, 812);

    expect(result.places).toHaveLength(0);
    expect(result.incomplete).toEqual({ reasonCode: 'LLM_UNAVAILABLE', itemIds: [25] });
  });

  it('질문은 세 개까지다', async () => {
    const result = await service({
      turns: [[list('t1')], [submit([answer(25, { questions: ['하나', '둘', '셋', '넷'] })])]],
    }).questions(1, 812);

    expect(result.places[0]?.questions).toEqual(['하나', '둘', '셋']);
  });

  it('🔴 확인 필요 항목 번호는 그 곳의 것만 남기고, 고르지 않으면 그 곳 전부다', async () => {
    const twoFindings = run([finding({ id: 301 }), finding({ id: 302 })]);
    const picked = await service({
      run: twoFindings, turns: [[list('t1')], [submit([answer(25, { findingIds: [302, 999] })])]],
    }).questions(1, 812);
    expect(picked.places[0]?.findingIds).toEqual([302]);

    const none = await service({
      run: twoFindings, turns: [[list('t1')], [submit([answer(25, { findingIds: [] })])]],
    }).questions(1, 812);
    expect(none.places[0]?.findingIds).toEqual([301, 302]);
  });

  it('🔴 모델이 실패하면 끝난 곳만 싣고 incomplete 로 알린다 (EX-AG-002)', async () => {
    const result = await service({ turns: [new LlmUnavailableError('TIMEOUT')] }).questions(1, 812);

    expect(result.places).toHaveLength(0);
    expect(result.incomplete).toEqual({ reasonCode: 'LLM_UNAVAILABLE', itemIds: [25] });
  });

  it('🔴 문의처 조회가 예산에 막히면 BUDGET_EXHAUSTED 로 알린다 — 거절하지 않는다', async () => {
    let calls = 0;
    const result = await new CheckQuestionService({
      audit: sourceOf({}),
      kto: () => new KtoClient({ transport: new ContactTransport(), logger: new InMemoryApiCallLogger() }),
      llm: () => new LlmClient({ provider: new ScriptedLlmProvider([[list('t1'), contact('t2', 25)], [submit([])]]), config: CONFIG }),
      budget: async () => (++calls === 1 ? allowed : blocked),
      lock: new AgentLock(),
    }).questions(1, 812);

    expect(result.incomplete).toEqual({ reasonCode: 'BUDGET_EXHAUSTED', itemIds: [25] });
  });

  it('🔴 예산이 다 찼으면 부르기 전에 429 다 (EI-CM-012)', async () => {
    const transport = new ContactTransport();
    await expect(service({ transport, budget: blocked }).questions(1, 812))
      .rejects.toMatchObject({ reasonCode: 'BUDGET_EXHAUSTED' });
    expect(transport.calls).toHaveLength(0);
  });

  it('🔴 같은 계정의 같은 에이전트가 도는 중이면 429 다 (EX-AG-004)', async () => {
    const lock = new AgentLock();
    const busy = service({ lock, turns: [[list('t1')], [submit([answer(25)])]] });
    const first = busy.questions(1, 812);
    await expect(busy.questions(1, 812)).rejects.toMatchObject({ reasonCode: 'RATE_LIMIT_EXCEEDED' });
    await first;
  });

  it('지시문에 판정 · 점수를 넣지 않는다 (FR-AG-022)', async () => {
    const provider = new ScriptedLlmProvider([[list('t1')], [submit([answer(25)])]]);
    await service({ provider }).questions(1, 812);

    expect(provider.requests[0]?.system).toContain('판정하지 않는다');
    expect(provider.requests[0]?.system).not.toMatch(/점수를 올|등급을 매|확인했다고 눌/);
  });
});

const URL = process.env.TEST_DATABASE_URL;

if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

describe.skipIf(URL === undefined)('CheckQuestionService — 실 DB (검수 결과를 읽기만 한다)', () => {
  let pool: Pool;
  let accountId: number;
  let theirId: number;
  let productId: number;
  let runId: number;
  let itemId: number;

  const live = (turns: readonly (readonly LlmAssistantBlock[] | Error)[]): CheckQuestionService =>
    new CheckQuestionService({
      // app.module 이 넘기는 것과 같은 AuditService 다. 읽기 메서드 넷만 쓴다
      audit: new AuditService(pool),
      kto: () => new KtoClient({ transport: new ContactTransport(), logger: new InMemoryApiCallLogger() }),
      llm: () => new LlmClient({ provider: new ScriptedLlmProvider(turns), config: CONFIG }),
      budget: async () => allowed,
      lock: new AgentLock(),
    });

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 4 });
    const accounts = await pool.query<{ id: string }>(
      `INSERT INTO account (email, password_hash) VALUES ($1,'x'), ($2,'x') RETURNING id`,
      [`check-${String(process.pid)}@t.test`, `check-other-${String(process.pid)}@t.test`],
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

  const seed = async (owner: number): Promise<void> => {
    const products = await pool.query<{ id: string }>(
      `INSERT INTO product (account_id, name, ldong_regn_cd, ldong_signgu_cd, start_date, nights, transport)
       VALUES ($1,'강릉 1박 2일','51','150', DATE '2026-10-23', 1, 'CAR') RETURNING id`,
      [owner],
    );
    productId = Number(products.rows[0]?.id);
    const items = await pool.query<{ id: string }>(
      `INSERT INTO itinerary_item
         (product_id, day_no, seq, start_time, end_time, end_time_source, place_label, item_type,
          kto_content_id, content_type_id, match_status)
       VALUES ($1, 1, 3, '19:30'::time, '20:30'::time, 'INPUT', '소나무집', 'MEAL', '2465063', 39, 'CONFIRMED')
       RETURNING id`,
      [productId],
    );
    itemId = Number(items.rows[0]?.id);
    const runs = await pool.query<{ id: string }>(
      `INSERT INTO audit_run (product_id, executed_at, ruleset_version, target_count, weight_snapshot)
       VALUES ($1, now(), 'v1.3.0', 1, '{"BLOCKER":50,"ERROR":10,"WARNING":4,"UNVERIFIED":3}'::jsonb)
       RETURNING id`,
      [productId],
    );
    runId = Number(runs.rows[0]?.id);
    await pool.query(
      `INSERT INTO finding (audit_run_id, rule_code, rule_version, severity, reason_code,
                            target_item_id, message, evidence, requires_external, external_source)
       VALUES ($1, 'R01', '1.0.0', 'UNVERIFIED', 'NO_HOURS_INFO', $2, '운영시간을 확인할 수 없습니다', '{}'::jsonb, true, 'KTO')`,
      [runId, itemId],
    );
  };

  it('🔴 남의 검수 실행은 볼 수 없다 (PM-DA-002)', async () => {
    await seed(theirId);
    await expect(live([]).questions(accountId, runId)).rejects.toBeInstanceOf(DomainException);
  });

  it('🔴 실행해도 판정과 출시 준비도가 그대로다 (FR-AG-022)', async () => {
    await seed(accountId);
    const before = await stateOf(pool, runId);

    const result = await live([
      [list('t1'), contact('t2', itemId)],
      [submit([{ itemId, tel: '033-640-4471', questions: ['그날 문을 여나요?', '몇 시까지 하나요?'] }])],
    ]).questions(accountId, runId);

    expect(result.places[0]).toMatchObject({ itemId, tel: '033-640-4471' });
    expect(result.places[0]?.visit).toEqual({ dayNo: 1, date: '2026-10-23', start: '19:30' });
    expect(await stateOf(pool, runId)).toEqual(before);
  });
});

/** 검수 실행 · 판정과 출시 준비도. 에이전트가 하나라도 바꾸면 달라진다 */
async function stateOf(pool: Pool, runId: number): Promise<Record<string, unknown>> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT r.readiness_score, r.target_count,
            (SELECT count(*)::text FROM finding WHERE audit_run_id = r.id) AS findings,
            (SELECT count(*)::text FROM finding WHERE audit_run_id = r.id AND confirmed_at IS NOT NULL) AS confirmed,
            (SELECT count(*)::text FROM finding WHERE audit_run_id = r.id AND dismissed_at IS NOT NULL) AS dismissed
       FROM audit_run r WHERE r.id = $1`,
    [runId],
  );
  return rows[0] ?? {};
}
