import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DomainException } from '../common/domain.exception';
import { NotificationService } from './notification.service';

/**
 * 알림 조회 관통 — **실 DB**.
 *
 * 계정 격리(PM-DA-002)와 비표출 무시 금지(FR-MO-037)가 여기서만 확인된다.
 * 문구는 DB 없이 도는 `notification-copy.spec` 이 본다.
 */

const URL = process.env.TEST_DATABASE_URL;
let counter = 0;
if (URL === undefined && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 인데 TEST_DATABASE_URL 이 없다');
}

const LIST = { unreadOnly: false, includeDismissed: false, page: 0, size: 20 };

describe.skipIf(URL === undefined)('NotificationService — 관통', () => {
  let pool: Pool;
  let service: NotificationService;
  let mine: number;
  let theirs: number;
  let productId: number;

  beforeAll(() => {
    pool = new Pool({ connectionString: URL, max: 4 });
    service = new NotificationService(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    const accounts = await pool.query<{ id: string }>(
      `INSERT INTO account (email, password_hash) VALUES ($1,'x'), ($2,'x') RETURNING id`,
      [`noti-${String(process.pid)}-${String(counter++)}@example.com`,
       `noti-${String(process.pid)}-${String(counter++)}@example.com`],
    );
    mine = Number(accounts.rows[0]?.id);
    theirs = Number(accounts.rows[1]?.id);

    const prod = await pool.query<{ id: string }>(
      `INSERT INTO product (account_id, name, ldong_regn_cd, start_date, nights, transport)
       VALUES ($1,'강릉 1박 2일','51', DATE '2026-10-13', 1, 'CAR') RETURNING id`,
      [mine],
    );
    productId = Number(prod.rows[0]?.id);
  });

  afterEach(async () => {
    await pool.query('DELETE FROM account WHERE id = ANY($1::bigint[])', [[mine, theirs]]);
  });

  async function insert(over: {
    kind?: string; condition?: number; hidden?: boolean; contentId?: string;
  } = {}): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO notification
         (product_id, kind, match_condition, kto_content_id, change_hash_from, change_hash_to,
          change_key, body)
       VALUES ($1,$2,$3,$4,'a','b',$5,$6::jsonb) RETURNING id`,
      [productId, over.kind ?? 'RISK', over.condition ?? 1, over.contentId ?? '126508',
       `k-${String(counter++)}`,
       JSON.stringify({ condition: over.condition ?? 1, hidden: over.hidden ?? false })],
    );
    return Number(rows[0]?.id);
  }

  it('내 알림이 목록에 나온다 — 상품명과 출발일이 붙는다 (FR-MO-033)', async () => {
    await insert();
    const res = await service.list(mine, LIST);
    const first = (res.content as Record<string, unknown>[])[0];
    expect(res.totalElements).toBe(1);
    expect(first?.productName).toBe('강릉 1박 2일');
    expect(first?.startDate).toBe('2026-10-13');
    expect(first?.what).not.toBe('');
    expect(first?.action).not.toBe('');
  });

  it('🔴 남의 알림은 목록에 안 나온다 (PM-DA-002)', async () => {
    await insert();
    const res = await service.list(theirs, LIST);
    expect(res.totalElements).toBe(0);
    expect(res.content).toEqual([]);
  });

  it('🔴 남의 알림은 읽음 처리할 수 없다 — 404 로 존재를 숨긴다 (EX-SY-003)', async () => {
    const id = await insert();
    await expect(service.markRead(id, theirs)).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainException && e.getStatus() === 404,
    );
    // 남의 시도로 내 알림이 읽음 처리되지 않았다
    const res = await service.list(mine, LIST);
    expect((res.content as Record<string, unknown>[])[0]?.readAt).toBeNull();
  });

  it('🔴 비표출 알림은 무시할 수 없다 — 403 (FR-MO-037 · PM-NG-010)', async () => {
    const id = await insert({ hidden: true });
    await expect(service.dismiss(id, mine)).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainException
        && e.getStatus() === 403 && e.reasonCode === 'FORBIDDEN_ACTION',
    );
    const res = await service.list(mine, LIST);
    expect((res.content as Record<string, unknown>[])[0]?.dismissedAt).toBeNull();
  });

  it('보통 알림은 무시되고 목록에서 빠진다', async () => {
    const id = await insert();
    await service.dismiss(id, mine);
    expect((await service.list(mine, LIST)).totalElements).toBe(0);
    expect((await service.list(mine, { ...LIST, includeDismissed: true })).totalElements).toBe(1);
  });

  it('🔴 이미 읽은 알림은 읽은 시각을 덮어쓰지 않는다', async () => {
    const id = await insert();
    const first = await service.markRead(id, mine);
    const second = await service.markRead(id, mine);
    expect(second.readAt).toBe(first.readAt);
  });

  it('kind 와 unread 로 거른다 (FR-MO-035)', async () => {
    await insert({ kind: 'RISK', condition: 1 });
    const opp = await insert({ kind: 'OPPORTUNITY', condition: 4, contentId: '999' });
    expect((await service.list(mine, { ...LIST, kind: 'RISK' })).totalElements).toBe(1);
    expect((await service.list(mine, { ...LIST, kind: 'OPPORTUNITY' })).totalElements).toBe(1);

    await service.markRead(opp, mine);
    expect((await service.list(mine, { ...LIST, unreadOnly: true })).totalElements).toBe(1);
  });

  describe('바뀐 곳 이름 (UI-S7-003 · #685)', () => {
    function withNames(resolve: (ids: readonly string[]) => Promise<ReadonlyMap<string, string>>): {
      service: NotificationService; asked: string[][];
    } {
      const asked: string[][] = [];
      return {
        asked,
        service: new NotificationService(pool, {
          resolve: (ids) => {
            asked.push([...ids]);
            return resolve(ids);
          },
        }),
      };
    }

    it('표시 시점에 읽은 이름이 카드에 붙는다', async () => {
      await insert({ condition: 3, contentId: '2874909' });
      const { service: named } = withNames(() => Promise.resolve(new Map([['2874909', '여수밤바다 불꽃축제']])));
      const first = ((await named.list(mine, LIST)).content as Record<string, unknown>[])[0];
      expect(first?.placeName).toBe('여수밤바다 불꽃축제');
    });

    it('🔴 표출이 중단된 곳은 묻지도 내보내지도 않는다 (FR-AU-071)', async () => {
      await insert({ hidden: true, contentId: '3536916' });
      const { service: named, asked } = withNames(() => Promise.resolve(new Map([['3536916', '새면 안 되는 이름']])));
      const first = ((await named.list(mine, LIST)).content as Record<string, unknown>[])[0];
      expect(first?.placeName).toBeNull();
      expect(asked.flat()).not.toContain('3536916');
    });

    it('🔴 이름을 못 읽어도 알림 목록은 나온다 — 예산 소진 · 공사 지연', async () => {
      await insert({ contentId: '126508' });
      const { service: named } = withNames(() => Promise.reject(new Error('BUDGET_EXHAUSTED')));
      const res = await named.list(mine, LIST);
      expect(res.totalElements).toBe(1);
      expect((res.content as Record<string, unknown>[])[0]?.placeName).toBeNull();
    });

    it('🔴 이름 조회가 끝나지 않아도 목록은 한도 안에 나온다 — 공사가 막힌 동안 30초 뒤 500 (#694)', async () => {
      await insert({ contentId: '126508' });
      // 영영 안 끝나는 조회. 2026-09-21 운영에서 공사 호출이 전부 시간 초과가 나던 때가 이랬다
      const stuck = new NotificationService(pool, { resolve: () => new Promise(() => undefined) }, 30);
      const started = Date.now();
      const res = await stuck.list(mine, LIST);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(res.totalElements).toBe(1);
      expect((res.content as Record<string, unknown>[])[0]?.placeName).toBeNull();
    });

    it('한도를 넘긴 뒤에 조회가 실패해도 처리되지 않은 거절이 남지 않는다', async () => {
      await insert({ contentId: '126508' });
      const lateFail = new NotificationService(pool, {
        resolve: () => new Promise((_, reject) => { setTimeout(() => { reject(new Error('KTO_TIMEOUT')); }, 60); }),
      }, 20);
      const res = await lateFail.list(mine, LIST);
      expect(res.totalElements).toBe(1);
      // 거절이 도착할 때까지 기다린다. 안 막았으면 vitest 가 unhandled rejection 으로 실패시킨다
      await new Promise((done) => { setTimeout(done, 100); });
    });

    it('🔴 느린 한 곳 때문에 읽은 이름까지 버리지 않는다 — 한도에 걸리면 읽은 데까지 (#697)', async () => {
      await insert({ contentId: 'fast' });
      await insert({ contentId: 'stuck' });
      const partial = new NotificationService(pool, {
        resolve: (ids) => ids[0] === 'stuck'
          ? new Promise(() => undefined)
          : Promise.resolve(new Map(ids.map((id) => [id, `이름-${id}`]))),
      }, 50);
      const names = ((await partial.list(mine, LIST)).content as Record<string, unknown>[])
        .map((n) => [n.ktoContentId, n.placeName]);
      expect(names).toContainEqual(['fast', '이름-fast']);
      expect(names).toContainEqual(['stuck', null]);
    });

    it('🔴 여러 곳을 동시에 읽는다 — 순서대로면 12곳에 3초라 한도를 넘는다 (#697)', async () => {
      for (let i = 0; i < 12; i += 1) await insert({ contentId: `c${String(i)}` });
      let running = 0;
      let peak = 0;
      const slow = new NotificationService(pool, {
        resolve: async (ids) => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((done) => { setTimeout(done, 40); });
          running -= 1;
          return new Map(ids.map((id) => [id, id]));
        },
      }, 300);
      const res = await slow.list(mine, LIST);
      // 12 × 40ms = 480ms 라 순서대로면 300ms 한도 안에 다 못 읽는다
      expect((res.content as Record<string, unknown>[]).filter((n) => n.placeName !== null)).toHaveLength(12);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(6);
    });

    it('못 찾은 곳만 null 이다 — 찾은 것까지 버리지 않는다', async () => {
      await insert({ contentId: '111' });
      await insert({ contentId: '222' });
      const { service: named } = withNames(() => Promise.resolve(new Map([['111', '찾은 곳']])));
      const names = ((await named.list(mine, LIST)).content as Record<string, unknown>[])
        .map((n) => [n.ktoContentId, n.placeName]);
      expect(names).toContainEqual(['111', '찾은 곳']);
      expect(names).toContainEqual(['222', null]);
    });

    it('이름 길이 없이 만든 서비스는 null 을 준다', async () => {
      await insert();
      expect(((await service.list(mine, LIST)).content as Record<string, unknown>[])[0]?.placeName).toBeNull();
    });
  });

  describe('무엇이 어떻게 바뀌었는지 · 해당 일정 (#703 · UI-S7-003 · 004)', () => {
    const HOURS = (close: string): string => JSON.stringify({ weeklyClosed: ['MON'], openHours: { open: '09:00', close } });

    async function addItem(contentId: string, label: string, dayNo = 1, start = '14:00'): Promise<void> {
      await pool.query(
        `INSERT INTO itinerary_item
           (product_id, day_no, seq, start_time, end_time_source, place_label, item_type, kto_content_id, match_status)
         VALUES ($1, $2, 1, $3, 'INPUT', $4, 'SIGHT', $5, 'CONFIRMED')`,
        [productId, dayNo, start, label, contentId],
      );
    }

    /** 검수 실행 하나와 그 실행이 남긴 판독 결과. `at` 은 알림 시각과의 앞뒤를 가른다 */
    async function auditedAt(contentId: string, normalized: string, at: string): Promise<void> {
      const run = await pool.query<{ id: string }>(
        `INSERT INTO audit_run (product_id, executed_at, ruleset_version, target_count, weight_snapshot)
         VALUES ($1, now() + $2::interval, '1.2.4', 1, '{"BLOCKER":25,"ERROR":10,"WARNING":4,"UNVERIFIED":3}'::jsonb)
         RETURNING id`, [productId, at]);
      await pool.query(
        `INSERT INTO content_fingerprint
           (audit_run_id, kto_content_id, content_type_id, fetched_at, kto_modified_time, show_flag,
            field_names, field_hash, normalized_json, parse_confidence)
         VALUES ($1, $2, 12, now() + $3::interval, '20260918143012', 1, ARRAY['usetime'], $4, $5::jsonb, 'CONFIRMED')`,
        [run.rows[0]?.id, contentId, at, 'a'.repeat(64), normalized]);
    }

    const first = async (svc: NotificationService = service): Promise<Record<string, unknown>> =>
      ((await svc.list(mine, LIST)).content as Record<string, unknown>[])[0] ?? {};

    it('🔴 일정에 든 곳이면 몇 일차 몇 시인지와 사용자가 적은 이름을 준다 — 공사를 부르지 않는다', async () => {
      await addItem('126508', '오죽헌', 2, '14:00');
      await insert({ contentId: '126508' });
      const asked: string[] = [];
      const named = new NotificationService(pool, { resolve: (ids) => { asked.push(...ids); return Promise.resolve(new Map()); } });
      const row = await first(named);
      expect(row.placeName).toBe('오죽헌');
      expect(row.schedule).toEqual({ dayNo: 2, startTime: '14:00' });
      expect(row.impact).toBe('2일차 14:00 일정입니다.');
      expect(asked).toEqual([]);
    });

    it('🔴 알림 직전 검수와 알림 뒤 첫 검수의 판독 결과 차이를 준다 (UI-S7-004)', async () => {
      await addItem('126508', '오죽헌');
      await auditedAt('126508', HOURS('18:00'), '-2 hours');
      await insert({ contentId: '126508' });
      await auditedAt('126508', HOURS('17:00'), '2 hours');
      // 그 뒤에 또 돈 검수는 이 알림이 말하던 변경이 아니다
      await auditedAt('126508', HOURS('16:00'), '5 hours');

      const row = await first();
      expect(row.changes).toEqual([{ label: '운영시간', before: '09:00~18:00', after: '09:00~17:00' }]);
      expect(row.what).toBe('운영시간 정보가 바뀌었습니다.');
      expect(row.current).toEqual([]);
    });

    it('🔴 견줄 이전 검수가 없으면 지금 판독값을 준다 — 검수한 뒤에 담은 곳', async () => {
      await addItem('126508', '황생가칼국수');
      await insert({ contentId: '126508' });
      await auditedAt('126508', HOURS('21:30'), '1 hour');

      const row = await first();
      expect(row.changes).toEqual([]);
      expect(row.what).toContain('이전 검수 기록이 없습니다');
      expect(row.current).toEqual([{ label: '휴무일', value: '월' }, { label: '운영시간', value: '09:00~21:30' }]);
    });

    it('아직 다시 검수 전이면 차이도 지금 값도 없다', async () => {
      await addItem('126508', '오죽헌');
      await auditedAt('126508', HOURS('18:00'), '-2 hours');
      await insert({ contentId: '126508' });
      const row = await first();
      expect(row.changes).toEqual([]);
      expect(row.current).toEqual([]);
      expect(row.what).toContain('다시 검수하면');
    });

    it('일정에 없는 곳은 schedule 이 null 이고 이름은 볼 때 읽은 것이다', async () => {
      await insert({ condition: 3, contentId: '2874909' });
      const named = new NotificationService(pool, { resolve: () => Promise.resolve(new Map([['2874909', '여수밤바다 불꽃축제']])) });
      const row = await first(named);
      expect(row.schedule).toBeNull();
      expect(row.placeName).toBe('여수밤바다 불꽃축제');
    });

    it('🔴 행사 기간과 겹치는 여행 일차, 관광정보 수정일을 준다', async () => {
      // 상품은 2026-10-13 출발 1박
      await pool.query(
        `INSERT INTO notification (product_id, kind, match_condition, kto_content_id, change_key, body)
         VALUES ($1, 'RISK', 3, 'fest', $2, $3::jsonb)`,
        [productId, `k-${String(counter++)}`, JSON.stringify({
          condition: 3, hidden: false, contentTypeId: '15', modifiedTime: '20260918143012',
          eventPeriod: { start: '2026-10-14', end: '2026-10-20' },
        })],
      );
      const row = await first();
      expect(row.eventPeriod).toEqual({ start: '2026-10-14', end: '2026-10-20' });
      expect(row.overlapDays).toEqual([2]);
      expect(row.modifiedOn).toBe('2026-09-18');
      expect(row.what).toBe('행사 기간은 10월 14일 ~ 10월 20일입니다. 여행 2일차와 겹칩니다.');
    });
  });

  describe('재검수 판정 차이 (FR-RU-061)', () => {
    async function item(contentId: string, label: string, seq = 1): Promise<number> {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO itinerary_item
           (product_id, day_no, seq, start_time, end_time_source, place_label, item_type, kto_content_id, match_status)
         VALUES ($1, 1, $2, '14:00', 'INPUT', $3, 'SIGHT', $4, 'CONFIRMED') RETURNING id`,
        [productId, seq, label, contentId],
      );
      return Number(rows[0]?.id);
    }

    /**
     * 알림 시각과의 앞뒤를 `at` 으로 가른 검수 실행과 그 판정들. `saw` 는 그 검수가 지문을 남긴 곳 —
     * 기본은 알림의 곳(126508)이다.
     */
    async function runAt(
      at: string,
      findings: { rule: string; severity: string; target: number | null; target2?: number | null }[],
      saw: readonly string[] = ['126508'],
    ): Promise<void> {
      const run = await pool.query<{ id: string }>(
        `INSERT INTO audit_run (product_id, executed_at, ruleset_version, target_count, weight_snapshot)
         VALUES ($1, now() + $2::interval, '1.2.9', 1, '{"BLOCKER":25,"ERROR":10,"WARNING":4,"UNVERIFIED":3}'::jsonb)
         RETURNING id`, [productId, at]);
      for (const contentId of saw) {
        await pool.query(
          `INSERT INTO content_fingerprint
             (audit_run_id, kto_content_id, content_type_id, fetched_at, kto_modified_time, show_flag,
              field_names, field_hash, parse_confidence)
           VALUES ($1, $2, 12, now() + $3::interval, '20260918143012', 1, ARRAY['usetime'], $4, 'CONFIRMED')`,
          [run.rows[0]?.id, contentId, at, 'c'.repeat(64)]);
      }
      for (const f of findings) {
        await pool.query(
          `INSERT INTO finding (audit_run_id, rule_code, rule_version, severity, reason_code, target_item_id, target_item_id2, message, evidence)
           VALUES ($1, $2, '1.0.0', $3, 'X', $4, $5, '판정', '{}'::jsonb)`,
          [run.rows[0]?.id, f.rule, f.severity, f.target, f.target2 ?? null]);
      }
    }

    const first = async (): Promise<Record<string, unknown>> =>
      ((await service.list(mine, LIST)).content as Record<string, unknown>[])[0] ?? {};

    it('🔴 알림 직전 검수와 알림 뒤 첫 검수에서 그 곳의 판정이 어떻게 달라졌는지 준다', async () => {
      const ojuk = await item('126508', '오죽헌', 1);
      const other = await item('999001', '경포대', 2);
      await runAt('-2 hours', [
        { rule: 'R01', severity: 'WARNING', target: ojuk },
        { rule: 'R02', severity: 'BLOCKER', target: ojuk },
        { rule: 'R04', severity: 'WARNING', target: other },
      ]);
      await insert({ contentId: '126508' });
      await runAt('2 hours', [
        { rule: 'R01', severity: 'BLOCKER', target: ojuk },
        { rule: 'R08', severity: 'ERROR', target: other, target2: ojuk },
      ]);
      // 그 뒤에 사람이 고쳐 다시 돈 검수는 이 변경의 영향이 아니다
      await runAt('5 hours', []);

      expect((await first()).verdictDiff).toEqual({
        added: [{ ruleCode: 'R08', severity: 'ERROR' }],
        removed: [{ ruleCode: 'R02', severity: 'BLOCKER' }],
        changed: [{ ruleCode: 'R01', from: 'WARNING', to: 'BLOCKER' }],
      });
    });

    it('판정이 그대로면 빈 차이를 준다 — 다시 검수했다는 사실은 남는다', async () => {
      const ojuk = await item('126508', '오죽헌');
      await runAt('-2 hours', [{ rule: 'R01', severity: 'BLOCKER', target: ojuk }]);
      await insert({ contentId: '126508' });
      await runAt('2 hours', [{ rule: 'R01', severity: 'BLOCKER', target: ojuk }]);
      expect((await first()).verdictDiff).toEqual({ added: [], removed: [], changed: [] });
    });

    it('🔴 검수한 뒤에 담은 곳이면 null 이다 — 직전 검수가 그 곳을 안 봤으니 「새로 생김」이 아니다', async () => {
      const ojuk = await item('126508', '오죽헌');
      await runAt('-2 hours', [], []);
      await insert({ contentId: '126508' });
      await runAt('2 hours', [{ rule: 'R01', severity: 'BLOCKER', target: ojuk }]);
      expect((await first()).verdictDiff).toBeNull();
    });

    it('아직 다시 검수 전이거나 일정에 없는 곳이면 null 이다 — 지어내지 않는다', async () => {
      const ojuk = await item('126508', '오죽헌');
      await runAt('-2 hours', [{ rule: 'R01', severity: 'BLOCKER', target: ojuk }]);
      await insert({ contentId: '126508' });
      expect((await first()).verdictDiff).toBeNull();

      await pool.query('DELETE FROM notification WHERE product_id = $1', [productId]);
      await insert({ contentId: '555555', condition: 2 });
      await runAt('2 hours', []);
      expect((await first()).verdictDiff).toBeNull();
    });
  });

  describe('새 소식의 넣을 자리 · 사전 확인 (UI-S7-008 · FR-MO-052)', () => {
    async function news(body: Record<string, unknown>): Promise<void> {
      await pool.query(
        `INSERT INTO notification (product_id, kind, match_condition, kto_content_id, change_key, body)
         VALUES ($1, 'OPPORTUNITY', 5, '888001', $2, $3::jsonb)`,
        [productId, `NEW:${String(counter++)}`, JSON.stringify({ condition: 5, contentTypeId: '12', hidden: false, ...body })]);
    }
    const first = async (): Promise<Record<string, unknown>> =>
      ((await service.list(mine, { ...LIST, kind: 'OPPORTUNITY' as const })).content as Record<string, unknown>[])[0] ?? {};

    it('🔴 배치가 남긴 자리와 사전 확인을 문장과 함께 준다 — 이동시간은 출처를 붙인다', async () => {
      await news({
        slot: { dayNo: 2, from: '12:00', to: '14:30', minutes: 150, dwellMinutes: 60 },
        precheck: { travel: 'FITS', inMinutes: 8, outMinutes: 9, addedMinutes: 5, shortMinutes: null, currentTimeBased: false },
      });
      const row = await first();
      expect(row.opportunity).toMatchObject({ slot: { dayNo: 2, from: '12:00', to: '14:30' }, travelSource: '카카오모빌리티' });
      expect(row.impact).toBe('2일차 12:00 ~ 14:30 빈 시간(150분)에 넣을 수 있어요. 머무는 시간은 약 60분으로 봤어요(알림 때 일정 기준).');
      expect(row.action).toBe('다른 일정과 겹치지 않고 앞뒤 이동(약 8분 · 9분)을 넣어도 빈 시간 안에 들어가요. 이동은 원래보다 약 5분 늘어요.');
      expect(row.verdictDiff).toBeNull();
    });

    it('자리를 남기기 전 새 소식은 조건 문장 그대로다', async () => {
      await news({});
      const row = await first();
      expect(row.opportunity).toBeNull();
      expect(row.impact).toBe('비어 있던 구간을 채울 수 있습니다.');
    });
  });

  it('안 읽은 건수를 함께 준다 — 헤더 배지가 쓴다', async () => {
    await insert();
    await insert({ contentId: '777' });
    expect((await service.list(mine, LIST)).unreadCount).toBe(2);
  });

  it('지문 비교값을 함께 준다 (FR-MO-058)', async () => {
    await insert();
    const first = ((await service.list(mine, LIST)).content as Record<string, unknown>[])[0];
    expect(first?.fingerprint).toEqual({ from: 'a', to: 'b' });
  });
});
